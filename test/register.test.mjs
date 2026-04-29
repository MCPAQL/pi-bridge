/**
 * Unit tests for registerCrudeTools. No subprocess: uses a mock ExtensionAPI
 * that captures registerTool calls, and a mock MCPHost whose call() returns
 * canned responses. Covers tool naming, param routing, success → content
 * frame mapping, and failure → throw mapping.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { registerCrudeTools } from "../dist/register.js";

function mockPi() {
	const tools = new Map();
	return {
		registerTool(t) {
			tools.set(t.name, t);
		},
		_tools: tools,
	};
}

function mockHost(name, callImpl) {
	const calls = [];
	return {
		serverName: name,
		async call(verb, op, params) {
			calls.push({ verb, op, params });
			return callImpl(verb, op, params);
		},
		async close() {},
		_calls: calls,
	};
}

test("registers exactly five <server>_<verb> tools", () => {
	const pi = mockPi();
	const host = mockHost("foo", () => ({ success: true, data: null }));
	registerCrudeTools(pi, host);
	const expected = ["foo_create", "foo_read", "foo_update", "foo_delete", "foo_execute"];
	assert.equal(pi._tools.size, 5);
	for (const name of expected) {
		assert.ok(pi._tools.has(name), `missing ${name}`);
	}
});

test("each tool's params schema requires operation as a string", () => {
	const pi = mockPi();
	const host = mockHost("foo", () => ({ success: true, data: null }));
	registerCrudeTools(pi, host);
	for (const tool of pi._tools.values()) {
		assert.equal(tool.parameters.type, "object");
		assert.ok(tool.parameters.required?.includes("operation"));
		assert.equal(tool.parameters.properties.operation.type, "string");
	}
});

test("execute() proxies operation+params to host.call with the matching verb", async () => {
	const pi = mockPi();
	const host = mockHost("svc", (verb, op, params) => ({
		success: true,
		data: { verb, op, params },
	}));
	registerCrudeTools(pi, host);

	const tool = pi._tools.get("svc_update");
	const result = await tool.execute(
		"call-1",
		{ operation: "set_x", params: { id: "abc", value: 42 } },
		undefined,
		undefined,
		{},
	);

	assert.equal(host._calls[0].verb, "update");
	assert.equal(host._calls[0].op, "set_x");
	assert.deepEqual(host._calls[0].params, { id: "abc", value: 42 });
	assert.deepEqual(result.details, {
		server: "svc",
		verb: "update",
		operation: "set_x",
		data: { verb: "update", op: "set_x", params: { id: "abc", value: 42 } },
	});
	assert.equal(result.content[0].type, "text");
});

test("execute() throws with [code] message format on host failure", async () => {
	const pi = mockPi();
	const host = mockHost("svc", () => ({
		success: false,
		error: { code: "NOT_FOUND", message: "no such resource" },
	}));
	registerCrudeTools(pi, host);

	const tool = pi._tools.get("svc_read");
	await assert.rejects(
		tool.execute("c", { operation: "get_thing" }, undefined, undefined, {}),
		/^Error: \[NOT_FOUND\] no such resource$/,
	);
});

test("execute() defaults params to empty object when omitted", async () => {
	const pi = mockPi();
	const host = mockHost("svc", () => ({ success: true, data: { ok: true } }));
	registerCrudeTools(pi, host);

	const tool = pi._tools.get("svc_read");
	await tool.execute("c", { operation: "ping" }, undefined, undefined, {});
	assert.deepEqual(host._calls[0].params, {});
});
