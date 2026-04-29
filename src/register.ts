/**
 * Per-server CRUDE tool registration (multi mode).
 *
 * Given an ExtensionAPI and an MCPHost, registers five Pi tools named
 * `<server>_create`, `<server>_read`, `<server>_update`, `<server>_delete`,
 * `<server>_execute`. Each tool's execute() proxies to host.call(verb, ...)
 * and translates the discriminated CrudeResponse into Pi's tool-result shape:
 * success becomes a JSON-rendered text content block + structured details;
 * failure throws so Pi surfaces the error to the LLM.
 *
 * Walking-skeleton scope: multi mode only. Unified mode, field selection,
 * and batch passthrough are tracked under #5/#12. The retry flow that
 * BridgeToolError.requiresConfirmation enables is tracked in #8.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";

import { BridgeToolError } from "./errors.js";
import type { CrudeVerb, CrudeWarning, MCPHost } from "./host.js";

const VERBS: readonly CrudeVerb[] = ["create", "read", "update", "delete", "execute"] as const;

const PARAMS_SCHEMA = Type.Object({
	operation: Type.String({
		description:
			"MCP-AQL operation name. Call the *_read tool with operation='introspect' to discover the operations available on this server.",
	}),
	params: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Operation-specific parameters; shape is defined by the operation.",
		}),
	),
});

type Params = Static<typeof PARAMS_SCHEMA>;

const VERB_DESCRIPTIONS: Record<CrudeVerb, string> = {
	create: "non-destructive additive operations",
	read: "safe read-only operations",
	update: "modifying operations that change existing state",
	delete: "destructive operations that remove state",
	execute: "runtime lifecycle operations (non-idempotent)",
};

function formatWarnings(warnings: CrudeWarning[]): string {
	const lines = warnings.map((w) => {
		const sev = w.severity ? ` (${w.severity})` : "";
		return `[${w.code}]${sev} ${w.message}`;
	});
	return `${warnings.length} warning${warnings.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

export function registerCrudeTools(pi: ExtensionAPI, host: MCPHost): void {
	for (const verb of VERBS) {
		const toolName = `${host.serverName}_${verb}`;
		pi.registerTool({
			name: toolName,
			label: `${host.serverName}.${verb}`,
			description: `MCP-AQL ${verb.toUpperCase()} on '${host.serverName}' — ${VERB_DESCRIPTIONS[verb]}. Call ${host.serverName}_read with operation='introspect' to list available operations.`,
			parameters: PARAMS_SCHEMA,
			async execute(_toolCallId, params: Params) {
				const response = await host.call(verb, params.operation, params.params ?? {});
				if (response.success) {
					const content = [
						{ type: "text" as const, text: JSON.stringify(response.data, null, 2) },
					];
					if (response.warnings && response.warnings.length > 0) {
						content.push({ type: "text" as const, text: formatWarnings(response.warnings) });
					}
					return {
						content,
						details: {
							server: host.serverName,
							verb,
							operation: params.operation,
							data: response.data,
							...(response.warnings && response.warnings.length > 0
								? { warnings: response.warnings }
								: {}),
						},
					};
				}
				throw new BridgeToolError({
					code: response.error.code,
					message: response.error.message,
					details: response.error.details,
					confirmation: response.confirmation,
					server: host.serverName,
					verb,
					operation: params.operation,
				});
			},
		});
	}
}
