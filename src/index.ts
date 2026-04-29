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
	pi.on("session_start", async (_event, ctx) => {
		const n = HARDCODED_SERVERS.length;
		ctx.ui.notify(
			n === 0
				? "@mcpaql/pi-bridge loaded (no servers configured)"
				: `@mcpaql/pi-bridge loaded — ${n} server(s)`,
			"info",
		);
	});

	for (const _server of HARDCODED_SERVERS) {
		// #4 — spawn MCP child for `_server` and obtain a typed handle.
		// #5 — register `<server>_create|_read|_update|_delete|_execute` Pi tools
		//      that proxy to the host's mcp_aql_* calls.
	}

	pi.on("session_shutdown", async () => {
		// #4 — terminate spawned MCP children here.
	});
};

export default piBridge;
