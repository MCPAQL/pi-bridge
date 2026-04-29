/**
 * Adapter package resolution: turns a `kind: "adapter"` config's
 * `adapter: "<spec>"` string into the {command, args} the host needs to
 * spawn it.
 *
 * Three input shapes are recognized, in this strict order:
 *
 *   1. **git URL** — `git:host/owner/repo@ref` or `git+https://…`.
 *      Currently throws "not yet implemented" — clone/install/cache lands
 *      in a follow-up. Checked first so a leading `git:` is never mistaken
 *      for an npm package whose name happens to start with `git`.
 *
 *   2. **Local path** — absolute, `./relative`, `../relative`, bare `.`,
 *      bare `..`, `~/home`, bare `~`, or Windows drive paths. Convention:
 *      `<path>/dist/server.js` is the entry. Spawned with `node`. Checked
 *      second so explicit local forms always win over ambiguous
 *      interpretation.
 *
 *   3. **npm package** — bare name like `@mcpaql/foo`, `pkg`, or
 *      version-pinned `pkg@1.2.3` / `@scope/name@1.2.3`. Spawned via
 *      `npx --yes <name>`; npx handles fetch + cache automatically.
 *      Specs with embedded slashes that aren't valid scoped-package shape
 *      are rejected as ambiguous before reaching this branch.
 *
 * Trust model: the adapter spec comes from a config file the user owns
 * (`~/.pi/mcpaql.config.json`), so `npx --yes <whatever-the-user-wrote>`
 * runs whatever the user typed. This is acceptable because the config is
 * local and user-controlled. If config ever flows in from a remote source,
 * this assumption needs revisiting.
 *
 * Errors are thrown so the entrypoint can route them through the same
 * failures[] path as spawn failures, surfacing via ctx.ui.notify.
 *
 * Future work tracked separately:
 *   - git URL support (clone + install + cache)
 *   - Per-adapter entry override (when `dist/server.js` doesn't fit) —
 *     candidates: read `package.json` `bin` field, or accept an object
 *     spec `{ path, entry }`.
 */

import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import type { ResolvedAdapterConfig } from "./config.js";
import { isNodeError } from "./util.js";

export interface ResolvedSpawn {
	command: string;
	args: string[];
}

const DEFAULT_ENTRY_RELATIVE = join("dist", "server.js");

// npm scoped-package shape: `@scope/name`, no extra slashes. Used to
// distinguish legitimate scoped names from ambiguous slash-containing
// strings like `adapters/my-server` that almost always indicate a missing
// `./` prefix.
const SCOPED_PACKAGE_RE = /^@[^/]+\/[^/]+$/;

export async function resolveAdapter(server: ResolvedAdapterConfig): Promise<ResolvedSpawn> {
	const spec = server.adapter;

	if (spec.startsWith("git:") || spec.startsWith("git+")) {
		throw new Error(
			`adapter "${spec}": git: URLs are not yet implemented (tracked in #31). Use a local path or an npm package name for now.`,
		);
	}

	if (isLocalPath(spec)) {
		return resolveLocalPath(spec);
	}

	if (spec.includes("/") && !SCOPED_PACKAGE_RE.test(spec)) {
		throw new Error(
			`adapter "${spec}": looks like a path but isn't rooted. Prefix with "./" for a relative path, or use the npm scoped-package form @scope/name.`,
		);
	}

	return { command: "npx", args: ["--yes", spec] };
}

function isLocalPath(spec: string): boolean {
	if (isAbsolute(spec)) return true;
	// Bare "." and ".." plus prefixed forms. Without the bare-equality checks,
	// these would match no other branch and silently fall through to `npx .`
	// or `npx ..` — valid npm semantics ("run the package in CWD") but almost
	// never what the user intended in a config file.
	if (spec === "." || spec.startsWith("./")) return true;
	if (spec === ".." || spec.startsWith("../")) return true;
	if (spec.startsWith("~/") || spec === "~") return true;
	// Windows drive-letter absolute paths — `C:\foo`, `D:/bar`. Recognized
	// defensively so a Windows user pasting a drive path gets a sensible
	// error instead of having it silently dispatched to npx. Note that the
	// supported runtime is Node 20+ on Linux/macOS; Windows is not on the
	// release matrix, so this is footprint, not full support.
	if (/^[A-Za-z]:[\\/]/.test(spec)) return true;
	return false;
}

async function resolveLocalPath(spec: string): Promise<ResolvedSpawn> {
	const expanded = expandHome(spec);
	const absolute = isAbsolute(expanded) ? expanded : resolvePath(expanded);
	const entry = join(absolute, DEFAULT_ENTRY_RELATIVE);

	// Probe the entry up front so config errors surface at startup rather
	// than at first tool call. R_OK rather than F_OK so a mode-000 file
	// produces EACCES (existence + readable), not just F_OK (existence).
	// We narrow on the error code so each failure mode gets actionable
	// feedback:
	//   ENOENT → "build the adapter first / wrong path"
	//   EACCES → "permission denied / check perms"
	//   anything else (EMFILE, EIO, …) → propagate verbatim, since giving
	//     it our generic message would actively mislead the user.
	try {
		await access(entry, fsConstants.R_OK);
	} catch (err) {
		if (isNodeError(err) && err.code === "EACCES") {
			throw new Error(
				`adapter local path "${spec}": permission denied reading ${entry} — check filesystem permissions on the adapter directory.`,
			);
		}
		if (isNodeError(err) && err.code === "ENOENT") {
			throw new Error(
				`adapter local path "${spec}": expected ${entry} (build the adapter first, or point adapter at a directory containing ${DEFAULT_ENTRY_RELATIVE}).`,
			);
		}
		throw err;
	}

	return { command: "node", args: [entry] };
}

function expandHome(spec: string): string {
	if (spec === "~") return homedir();
	if (spec.startsWith("~/")) return join(homedir(), spec.slice(2));
	return spec;
}
