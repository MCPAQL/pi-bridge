/**
 * MCP client host: spawns a configured MCP-AQL server as a child process,
 * connects via stdio, and exposes a typed handle for the five CRUDE verbs.
 *
 * The handle's contract is MCP-AQL semantics — callers receive a discriminated
 * { success, data | error } response. The MCP layer (callTool, content frames)
 * is an implementation detail.
 *
 * Walking-skeleton scope: spawn, connect, call, close. Restart-on-drop and
 * configurable stderr log location are tracked as follow-ups under #4.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Narrow shape the host needs to spawn an MCP child. The richer config
 * (trust, endpointMode, direct/adapter discriminator) lives in src/config.ts;
 * the entrypoint resolves it down to this before spawning.
 */
export interface HostSpawnConfig {
	name: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export type CrudeVerb = "create" | "read" | "update" | "delete" | "execute";

export type CrudeError = {
	code: string;
	message: string;
	details?: unknown;
};

export type CrudeResponse =
	| { success: true; data: unknown }
	| { success: false; error: CrudeError };

export interface MCPHost {
	readonly serverName: string;
	call(verb: CrudeVerb, operation: string, params?: Record<string, unknown>): Promise<CrudeResponse>;
	close(): Promise<void>;
}

const TOOL_FOR_VERB: Record<CrudeVerb, string> = {
	create: "mcp_aql_create",
	read: "mcp_aql_read",
	update: "mcp_aql_update",
	delete: "mcp_aql_delete",
	execute: "mcp_aql_execute",
};

export async function spawnHost(config: HostSpawnConfig): Promise<MCPHost> {
	const env = config.env ? { ...filteredProcessEnv(), ...config.env } : undefined;

	const transport = new StdioClientTransport({
		command: config.command,
		args: config.args,
		env,
		stderr: "inherit",
	});

	const client = new Client(
		{ name: `@mcpaql/pi-bridge:${config.name}`, version: "0.0.0" },
		{ capabilities: {} },
	);

	await client.connect(transport);

	return {
		serverName: config.name,
		async call(verb, operation, params = {}) {
			const result = await client.callTool({
				name: TOOL_FOR_VERB[verb],
				arguments: { operation, params },
			});
			return parseCrudeResponse(result);
		},
		async close() {
			await client.close();
		},
	};
}

function filteredProcessEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

export function parseCrudeResponse(result: unknown): CrudeResponse {
	if (!result || typeof result !== "object") {
		return malformed("Empty MCP response");
	}
	const r = result as {
		structuredContent?: unknown;
		content?: unknown;
		isError?: boolean;
	};

	if (r.structuredContent && typeof r.structuredContent === "object") {
		return r.structuredContent as CrudeResponse;
	}

	if (Array.isArray(r.content)) {
		const first = r.content[0] as { type?: string; text?: string } | undefined;
		if (first?.type === "text" && typeof first.text === "string") {
			try {
				return JSON.parse(first.text) as CrudeResponse;
			} catch {
				// Fall through to malformed.
			}
		}
	}

	if (r.isError) {
		return {
			success: false,
			error: {
				code: "UPSTREAM_ERROR",
				message: "Upstream reported an error with an unparseable payload",
			},
		};
	}

	return malformed("Could not parse MCP-AQL response from upstream");
}

function malformed(message: string): CrudeResponse {
	return { success: false, error: { code: "MALFORMED_RESPONSE", message } };
}
