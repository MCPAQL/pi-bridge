/**
 * @mcpaql/pi-bridge — Pi extension entrypoint.
 *
 * Hosts MCP-AQL adapters configured by the user and exposes their CRUDE
 * operations as per-server Pi tools (`<server>_create`, `<server>_read`, …).
 *
 * Walking-skeleton scope: hardcoded inline config (real schema/parser is #3),
 * MCP child host stubbed (lands in #4), CRUDE registration stubbed (lands in #5).
 * Pi awaits async factories before `session_start`, so all tool registrations
 * land before the LLM sees the tool list.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { type MCPHost, spawnHost } from "./host.js";

export type TrustLevel = "untrusted" | "user" | "developer" | "admin";

export type EndpointMode = "multi" | "unified";

export interface ServerConfig {
	name: string;
	transport: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	direct?: boolean;
	trust: TrustLevel;
	endpointMode?: EndpointMode;
}

const HARDCODED_SERVERS: ServerConfig[] = [
	// #13 fills this with the github MCP-AQL adapter entry.
];

const piBridge = async function (pi: ExtensionAPI): Promise<void> {
	const hosts: MCPHost[] = [];
	const failures: Array<{ name: string; reason: string }> = [];

	for (const server of HARDCODED_SERVERS) {
		try {
			hosts.push(await spawnHost(server));
		} catch (err) {
			failures.push({
				name: server.name,
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (hosts.length > 0) {
			ctx.ui.notify(
				`@mcpaql/pi-bridge loaded — ${hosts.length} server(s): ${hosts.map((h) => h.serverName).join(", ")}`,
				"info",
			);
		} else {
			ctx.ui.notify("@mcpaql/pi-bridge loaded (no servers configured)", "info");
		}
		for (const f of failures) {
			ctx.ui.notify(`@mcpaql/pi-bridge: failed to spawn ${f.name} — ${f.reason}`, "warning");
		}
	});

	for (const _host of hosts) {
		// #5 — register `<server>_create|_read|_update|_delete|_execute` Pi tools
		//      that proxy to host.call(verb, operation, params).
	}

	pi.on("session_shutdown", async () => {
		await Promise.allSettled(hosts.map((h) => h.close()));
	});
};

export default piBridge;
