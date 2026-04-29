/**
 * Unit tests for registerCrudeTools. No subprocess: uses a mock ExtensionAPI
 * that captures registerTool calls, and a mock MCPHost whose call() returns
 * canned responses. Covers tool naming, param routing, success → content
 * frame mapping, and failure → throw mapping.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BridgeToolError, ConfirmationRequiredError } from "../dist/errors.js";
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

test("execute() throws BridgeToolError preserving structured error fields", async () => {
	const pi = mockPi();
	const host = mockHost("svc", () => ({
		success: false,
		error: {
			code: "NOT_FOUND",
			message: "no such resource",
			details: { id: "abc" },
		},
	}));
	registerCrudeTools(pi, host);

	const tool = pi._tools.get("svc_read");
	await assert.rejects(
		tool.execute("c", { operation: "get_thing" }, undefined, undefined, {}),
		(err) => {
			assert.ok(err instanceof BridgeToolError, "expected BridgeToolError instance");
			assert.equal(err.code, "NOT_FOUND");
			assert.equal(err.message, "[NOT_FOUND] no such resource");
			assert.deepEqual(err.details, { id: "abc" });
			assert.equal(err.server, "svc");
			assert.equal(err.verb, "read");
			assert.equal(err.operation, "get_thing");
			assert.equal(err.requiresConfirmation, false);
			return true;
		},
	);
});

test("execute() throws ConfirmationRequiredError on CONFIRMATION_REQUIRED + envelope", async () => {
	const pi = mockPi();
	const host = mockHost("svc", () => ({
		success: false,
		error: { code: "CONFIRMATION_REQUIRED", message: "destructive op needs approval" },
		confirmation: {
			token: "tok-xyz",
			expires_at: "2026-04-29T20:00:00Z",
			message: "This will delete 47 records.",
			reasons: ["Operation is destructive", "Affects 47 records"],
		},
	}));
	registerCrudeTools(pi, host);

	const tool = pi._tools.get("svc_delete");
	await assert.rejects(
		tool.execute("c", { operation: "purge" }, undefined, undefined, {}),
		(err) => {
			assert.ok(err instanceof ConfirmationRequiredError, "expected subclass instance");
			assert.ok(err instanceof BridgeToolError, "subclass extends base");
			assert.equal(err.code, "CONFIRMATION_REQUIRED");
			assert.equal(err.requiresConfirmation, true);
			// Subclass narrows confirmation to non-optional — these reads
			// don't need optional chaining and would fail typecheck if they did.
			assert.equal(err.confirmation.token, "tok-xyz");
			assert.deepEqual(err.confirmation.reasons, [
				"Operation is destructive",
				"Affects 47 records",
			]);
			return true;
		},
	);
});

test("CONFIRMATION_REQUIRED without envelope falls back to BridgeToolError", async () => {
	// Defensive: an upstream that returns the code without the {token, expires_at}
	// envelope can't be retried, so we throw the base class (NOT the subclass)
	// — #8's `instanceof ConfirmationRequiredError` check skips it correctly.
	const pi = mockPi();
	const host = mockHost("svc", () => ({
		success: false,
		error: { code: "CONFIRMATION_REQUIRED", message: "needs confirmation but no token" },
	}));
	registerCrudeTools(pi, host);

	const tool = pi._tools.get("svc_delete");
	await assert.rejects(
		tool.execute("c", { operation: "purge" }, undefined, undefined, {}),
		(err) => {
			assert.ok(err instanceof BridgeToolError);
			assert.equal(err instanceof ConfirmationRequiredError, false);
			assert.equal(err.code, "CONFIRMATION_REQUIRED");
			assert.equal(err.requiresConfirmation, false);
			return true;
		},
	);
});

test("execute() appends warnings to content and details on success", async () => {
	const pi = mockPi();
	const host = mockHost("svc", () => ({
		success: true,
		data: { id: "x" },
		warnings: [
			{ code: "DEPRECATED_FIELD", message: "field 'legacy_id' is deprecated" },
			{ code: "RATE_LIMIT_NEAR", message: "approaching rate limit", severity: "high" },
		],
	}));
	registerCrudeTools(pi, host);

	const tool = pi._tools.get("svc_create");
	const result = await tool.execute("c", { operation: "make" }, undefined, undefined, {});

	assert.equal(result.content.length, 2);
	assert.equal(result.content[0].type, "text");
	assert.match(result.content[1].text, /2 warnings:/);
	assert.match(result.content[1].text, /\[DEPRECATED_FIELD\]/);
	assert.match(result.content[1].text, /\[RATE_LIMIT_NEAR\] \(high\)/);
	assert.equal(result.details.warnings.length, 2);
});

test("execute() omits warnings field on details when no warnings present", async () => {
	const pi = mockPi();
	const host = mockHost("svc", () => ({ success: true, data: { ok: true } }));
	registerCrudeTools(pi, host);

	const tool = pi._tools.get("svc_read");
	const result = await tool.execute("c", { operation: "ping" }, undefined, undefined, {});
	assert.equal(result.content.length, 1);
	assert.equal("warnings" in result.details, false);
});

test("execute() defaults params to empty object when omitted", async () => {
	const pi = mockPi();
	const host = mockHost("svc", () => ({ success: true, data: { ok: true } }));
	registerCrudeTools(pi, host);

	const tool = pi._tools.get("svc_read");
	await tool.execute("c", { operation: "ping" }, undefined, undefined, {});
	assert.deepEqual(host._calls[0].params, {});
});
