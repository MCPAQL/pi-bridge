#!/usr/bin/env node
/**
 * Mock MCP-AQL server for the bridge's tests.
 *
 * Speaks MCP over stdio. Exposes the five mcp_aql_* CRUDE tools and returns
 * canned discriminated responses keyed off the operation name. Used by
 * test/host.test.mjs to exercise spawnHost end-to-end without depending on
 * the real github adapter.
 *
 * Operations:
 *   - "introspect"      → success with a small operations list
 *   - "echo"            → success, echoes the calling tool name and params
 *   - "fail_validation" → failure with VALIDATION_ERROR
 *   - "structured_only" → success, structuredContent only (no text frame)
 *   - "text_only"       → success, text frame only (no structuredContent)
 *   - any other         → failure with UNKNOWN_OPERATION
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
	"mcp_aql_create",
	"mcp_aql_read",
	"mcp_aql_update",
	"mcp_aql_delete",
	"mcp_aql_execute",
];

const server = new Server(
	{ name: "mock-mcpaql", version: "0.0.1" },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: TOOLS.map((name) => ({
		name,
		description: `Mock MCP-AQL ${name}`,
		inputSchema: {
			type: "object",
			properties: {
				operation: { type: "string" },
				params: { type: "object" },
			},
			required: ["operation"],
		},
	})),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const toolName = request.params.name;
	const args = request.params.arguments ?? {};
	const op = args.operation;
	const params = args.params ?? {};

	if (op === "introspect") {
		return frame({
			success: true,
			data: {
				_protocol: { version: "0.1.0", mode: "crude" },
				operations: [
					{ name: "introspect", endpoint: "READ", description: "self" },
					{ name: "echo", endpoint: "READ", description: "echo" },
				],
			},
		});
	}

	if (op === "echo") {
		return frame({
			success: true,
			data: { tool: toolName, operation: op, params },
		});
	}

	if (op === "fail_validation") {
		return frame({
			success: false,
			error: {
				code: "VALIDATION_ERROR",
				message: "missing required parameter",
				details: { field: "id" },
			},
		});
	}

	if (op === "structured_only") {
		const payload = { success: true, data: { via: "structuredContent" } };
		return { content: [], structuredContent: payload };
	}

	if (op === "text_only") {
		const payload = { success: true, data: { via: "text" } };
		return { content: [{ type: "text", text: JSON.stringify(payload) }] };
	}

	return frame({
		success: false,
		error: { code: "UNKNOWN_OPERATION", message: `Unknown: ${op}` },
	});
});

function frame(payload) {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		structuredContent: payload,
	};
}

await server.connect(new StdioServerTransport());
