/**
 * @mcpaql/pi-bridge — Pi extension entrypoint.
 *
 * Hosts MCP-AQL adapters configured in ~/.pi/mcpaql.config.json and exposes
 * their CRUDE operations as per-server Pi tools (`<server>_create`,
 * `<server>_read`, …). Pi awaits async factories before session_start, so
 * config load + child spawn + tool registration all complete before the LLM
 * sees the tool list.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { ConfigError, loadConfig, type ResolvedServerConfig } from "./config.js";
import { type MCPHost, spawnHost } from "./host.js";
import { registerCrudeTools } from "./register.js";

// Re-exports so consumers using the package programmatically don't need
// to reach into subpaths.
export {
	type EndpointMode,
	type LoadResult,
	type ResolvedAdapterConfig,
	type ResolvedDirectConfig,
	type ResolvedServerConfig,
	type TrustLevel,
	ConfigError,
	loadConfig,
	MCPAQL_CONFIG_SCHEMA,
} from "./config.js";

const piBridge = async function (pi: ExtensionAPI): Promise<void> {
	const hosts: MCPHost[] = [];
	const failures: string[] = [];
	const notices: string[] = [];

	let configResult: Awaited<ReturnType<typeof loadConfig>> | null = null;
	try {
		configResult = await loadConfig();
		notices.push(...configResult.notices);
	} catch (err) {
		if (err instanceof ConfigError) {
			failures.push(err.message);
		} else {
			failures.push(`Config load failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	for (const server of configResult?.servers ?? []) {
		// Adapter resolution (#6) is not yet implemented. Surface this as an
		// info-level notice rather than a warning, so users distinguish
		// "feature isn't built yet" from "spawn actually failed".
		if (server.kind === "adapter") {
			notices.push(
				`Server "${server.name}": kind="adapter" is not yet implemented — waiting on #6 (adapter package resolution). Skipping; use kind="direct" with command/args for now.`,
			);
			continue;
		}
		try {
			hosts.push(await spawnAndRegister(pi, server));
		} catch (err) {
			failures.push(
				`Server "${server.name}": ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (hosts.length > 0) {
			ctx.ui.notify(
				`@mcpaql/pi-bridge loaded — ${hosts.length} server(s): ${hosts.map((h) => h.serverName).join(", ")}`,
				"info",
			);
		} else if (configResult?.loaded) {
			ctx.ui.notify("@mcpaql/pi-bridge: config loaded but no servers spawned.", "warning");
		} else {
			ctx.ui.notify("@mcpaql/pi-bridge loaded (no config file).", "info");
		}
		for (const note of notices) {
			ctx.ui.notify(note, "info");
		}
		for (const f of failures) {
			ctx.ui.notify(`@mcpaql/pi-bridge: ${f}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		await Promise.allSettled(hosts.map((h) => h.close()));
	});
};

async function spawnAndRegister(
	pi: ExtensionAPI,
	server: ResolvedServerConfig,
): Promise<MCPHost> {
	if (server.kind === "adapter") {
		// Defense in depth — the loop above filters these out and surfaces a
		// notice, but if a future code path reaches here, fail loud rather
		// than spawn nothing.
		throw new Error(
			`internal: kind="adapter" reached spawnAndRegister; the entrypoint should have filtered "${server.name}" out (waiting on #6).`,
		);
	}

	const host = await spawnHost({
		name: server.name,
		command: server.command,
		args: server.args,
		env: server.env,
	});
	registerCrudeTools(pi, host);
	return host;
}

export default piBridge;
