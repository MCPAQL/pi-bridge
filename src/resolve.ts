/**
 * Adapter package resolution: turns a `kind: "adapter"` config's
 * `adapter: "<spec>"` string into the {command, args} the host needs to
 * spawn it.
 *
 * Three input shapes are recognized:
 *
 *   - **Local path** — absolute, ./relative, ~/home, or path-with-slash.
 *     Convention: <path>/dist/server.js is the entry. Spawned with `node`.
 *
 *   - **npm package** — bare name like `@mcpaql/foo` or `pkg`. Spawned via
 *     `npx --yes <name>`; npx handles fetch + cache automatically.
 *
 *   - **git URL** — `git:host/owner/repo@ref` (Pi-mono convention). Not
 *     yet implemented; throws a clear error pointing at the tracking
 *     issue. The clone+install+cache work lands in a follow-up.
 *
 * Errors are thrown so the entrypoint can route them through the same
 * failures[] path as spawn failures, surfacing via ctx.ui.notify.
 */

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import type { ResolvedAdapterConfig } from "./config.js";

export interface ResolvedSpawn {
	command: string;
	args: string[];
}

export async function resolveAdapter(server: ResolvedAdapterConfig): Promise<ResolvedSpawn> {
	const spec = server.adapter;

	if (spec.startsWith("git:") || spec.startsWith("git+")) {
		throw new Error(
			`adapter "${spec}": git: URLs are not yet implemented. Use a local path or an npm package name for now (tracked separately as a follow-up to #6).`,
		);
	}

	if (isLocalPath(spec)) {
		return resolveLocalPath(spec);
	}

	// Reject ambiguous specs that look like paths but aren't explicitly
	// rooted. Without this, "adapters/my-server" would silently resolve to
	// `npx adapters/my-server`, which is almost never what the user meant.
	// The only legitimate slash-containing form for npm is @scope/name.
	if (spec.includes("/") && !/^@[^/]+\/[^/]+$/.test(spec)) {
		throw new Error(
			`adapter "${spec}": looks like a path but isn't rooted. Prefix with "./" for a relative path, or use the npm scoped-package form @scope/name.`,
		);
	}

	// Anything else: treat as an npm package name. npx handles cache + install.
	return { command: "npx", args: ["--yes", spec] };
}

function isLocalPath(spec: string): boolean {
	if (isAbsolute(spec)) return true;
	if (spec.startsWith("./") || spec.startsWith("../")) return true;
	if (spec.startsWith("~/") || spec === "~") return true;
	// Accept Windows-style absolute paths if someone hands us one (defensive;
	// our supported runtimes are Node 20+ on Linux/macOS, but easy to allow).
	if (/^[A-Za-z]:[\\/]/.test(spec)) return true;
	return false;
}

async function resolveLocalPath(spec: string): Promise<ResolvedSpawn> {
	const expanded = expandHome(spec);
	const absolute = isAbsolute(expanded) ? expanded : resolvePath(expanded);
	const entry = join(absolute, "dist", "server.js");

	try {
		await access(entry);
	} catch {
		throw new Error(
			`adapter local path "${spec}" — expected ${entry} (build the adapter first, or point adapter at a directory containing dist/server.js).`,
		);
	}

	return { command: "node", args: [entry] };
}

function expandHome(spec: string): string {
	if (spec === "~") return homedir();
	if (spec.startsWith("~/")) return join(homedir(), spec.slice(2));
	return spec;
}
