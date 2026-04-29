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
import { resolveAdapter } from "./resolve.js";

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

export type { CrudeError, CrudeResponse, CrudeVerb, MCPHost } from "./host.js";

/**
 * Project a ResolvedServerConfig down to a HostSpawnConfig and spawn the
 * child. Direct-mode passes command/args straight through; adapter-mode
 * goes through resolveAdapter() to turn the package/path spec into a
 * spawn pair first. This is the only place the projection happens, so
 * tests that exercise the loadConfig → spawnHost chain go through here.
 */
export async function spawnFromResolved(server: ResolvedServerConfig): Promise<MCPHost> {
	const spawnSpec =
		server.kind === "direct"
			? { command: server.command, args: server.args }
			: await resolveAdapter(server);

	return spawnHost({
		name: server.name,
		command: spawnSpec.command,
		args: spawnSpec.args,
		env: server.env,
	});
}

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
	const host = await spawnFromResolved(server);
	registerCrudeTools(pi, host);
	return host;
}

export default piBridge;
