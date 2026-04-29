/**
 * Integration tests for spawnHost against the mock MCP-AQL server.
 * Spawns a real child process per test, exercises the full stdio path.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { spawnHost } from "../dist/host.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(HERE, "fixtures/mock-mcpaql-server.mjs");

const baseConfig = {
	name: "mock",
	transport: "stdio",
	command: "node",
	args: [MOCK],
	trust: "user",
	endpointMode: "multi",
};

test("spawnHost connects, exposes serverName, and routes a successful introspect", async () => {
	const host = await spawnHost(baseConfig);
	try {
		assert.equal(host.serverName, "mock");
		const r = await host.call("read", "introspect", {});
		assert.equal(r.success, true, JSON.stringify(r));
		assert.ok(Array.isArray(r.data.operations));
		assert.equal(r.data._protocol.mode, "crude");
	} finally {
		await host.close();
	}
});

test("spawnHost surfaces discriminated VALIDATION_ERROR responses", async () => {
	const host = await spawnHost(baseConfig);
	try {
		const r = await host.call("read", "fail_validation", {});
		assert.equal(r.success, false);
		assert.equal(r.error.code, "VALIDATION_ERROR");
		assert.match(r.error.message, /missing required/);
	} finally {
		await host.close();
	}
});

test("each verb routes to the matching mcp_aql_<verb> tool name", async () => {
	const host = await spawnHost(baseConfig);
	try {
		for (const verb of ["create", "read", "update", "delete", "execute"]) {
			const r = await host.call(verb, "echo", { x: 1, verb });
			assert.equal(r.success, true);
			assert.equal(r.data.tool, `mcp_aql_${verb}`);
			assert.equal(r.data.operation, "echo");
			assert.deepEqual(r.data.params, { x: 1, verb });
		}
	} finally {
		await host.close();
	}
});

test("structuredContent-only responses are parsed", async () => {
	const host = await spawnHost(baseConfig);
	try {
		const r = await host.call("read", "structured_only", {});
		assert.equal(r.success, true);
		assert.equal(r.data.via, "structuredContent");
	} finally {
		await host.close();
	}
});

test("text-only responses are parsed via JSON fallback", async () => {
	const host = await spawnHost(baseConfig);
	try {
		const r = await host.call("read", "text_only", {});
		assert.equal(r.success, true);
		assert.equal(r.data.via, "text");
	} finally {
		await host.close();
	}
});

test("close() shuts down cleanly without throwing", async () => {
	const host = await spawnHost(baseConfig);
	await host.call("read", "introspect", {});
	await host.close();
});
