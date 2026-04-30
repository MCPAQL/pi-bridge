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

/**
 * Non-fatal advisory attached to a successful response. Spec'd in
 * operation-result.schema.json; common shapes include deprecation notices,
 * partial-result indicators, and rate-limit warnings.
 */
export type CrudeWarning = {
	code: string;
	message: string;
	details?: Record<string, unknown>;
	severity?: "low" | "medium" | "high";
};

/**
 * Confirmation envelope attached to a CONFIRMATION_REQUIRED failure.
 * Carries the token the caller must echo back to retry the gated operation,
 * plus the human-readable prompt and reasons. Wired into the actual retry
 * flow by #8; preserved here so callers (and #8) can find it intact.
 */
export type CrudeConfirmation = {
	token: string;
	expires_at: string;
	message?: string;
	reasons?: string[];
};

export type CrudeResponse =
	| { success: true; data: unknown; warnings?: CrudeWarning[] }
	| { success: false; error: CrudeError; confirmation?: CrudeConfirmation };

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
		const validated = validateCrudeResponse(r.structuredContent);
		if (validated) return validated;
		// structuredContent was present but didn't match the discriminated shape;
		// fall through to other paths so a parseable text frame can still win.
	}

	if (Array.isArray(r.content)) {
		const first = r.content[0] as { type?: string; text?: string } | undefined;
		if (first?.type === "text" && typeof first.text === "string") {
			try {
				const parsed = JSON.parse(first.text) as unknown;
				const validated = validateCrudeResponse(parsed);
				if (validated) return validated;
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

/**
 * Minimal runtime shape check for the MCP-AQL discriminated response.
 * Returns the value typed as CrudeResponse if it conforms, else undefined.
 * This is the boundary between user-supplied / third-party servers and
 * the rest of the bridge — typecasts alone aren't enough.
 *
 * Side fields (`warnings` on success, `confirmation` on failure) are
 * preserved when present and well-shaped, dropped silently when malformed.
 * The discriminator (`success: true | false` + `data` / `error`) is the
 * only required shape; advisories are best-effort.
 */
function validateCrudeResponse(value: unknown): CrudeResponse | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as {
		success?: unknown;
		data?: unknown;
		error?: unknown;
		warnings?: unknown;
		confirmation?: unknown;
	};
	if (v.success === true && "data" in v) {
		const out: CrudeResponse = { success: true, data: v.data };
		const warnings = parseWarnings(v.warnings);
		if (warnings) out.warnings = warnings;
		return out;
	}
	if (v.success === false && v.error && typeof v.error === "object") {
		const e = v.error as { code?: unknown; message?: unknown; details?: unknown };
		if (typeof e.code === "string" && typeof e.message === "string") {
			const out: CrudeResponse = {
				success: false,
				error: { code: e.code, message: e.message, details: e.details },
			};
			const confirmation = parseConfirmation(v.confirmation);
			if (confirmation) out.confirmation = confirmation;
			return out;
		}
	}
	return undefined;
}

function parseWarnings(value: unknown): CrudeWarning[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: CrudeWarning[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const w = item as {
			code?: unknown;
			message?: unknown;
			details?: unknown;
			severity?: unknown;
		};
		if (typeof w.code !== "string" || typeof w.message !== "string") continue;
		const warning: CrudeWarning = { code: w.code, message: w.message };
		// Spec says details is `type: object` which JSON Schema excludes arrays
		// from; `typeof [] === "object"` would otherwise pass this guard.
		if (w.details && typeof w.details === "object" && !Array.isArray(w.details)) {
			warning.details = w.details as Record<string, unknown>;
		}
		if (w.severity === "low" || w.severity === "medium" || w.severity === "high") {
			warning.severity = w.severity;
		}
		out.push(warning);
	}
	return out.length > 0 ? out : undefined;
}

function parseConfirmation(value: unknown): CrudeConfirmation | undefined {
	if (!value || typeof value !== "object") return undefined;
	const c = value as {
		token?: unknown;
		expires_at?: unknown;
		message?: unknown;
		reasons?: unknown;
	};
	if (typeof c.token !== "string" || typeof c.expires_at !== "string") return undefined;
	const out: CrudeConfirmation = { token: c.token, expires_at: c.expires_at };
	if (typeof c.message === "string") out.message = c.message;
	if (Array.isArray(c.reasons) && c.reasons.every((r) => typeof r === "string")) {
		out.reasons = c.reasons as string[];
	}
	return out;
}

function malformed(message: string): CrudeResponse {
	return { success: false, error: { code: "MALFORMED_RESPONSE", message } };
}
