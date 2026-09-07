/**
 * Entrypoint integration tests: exercises the loadConfig → spawnFromResolved
 * → host.call chain against the mock MCP-AQL server.
 *
 * Unit tests in config.test.mjs cover loadConfig in isolation; host.test.mjs
 * covers spawnHost in isolation. This file covers the boundary the entrypoint
 * lives on — the projection from a ResolvedServerConfig (with kind, trust,
 * env, etc.) down to a HostSpawnConfig. Catches regressions where the
 * projection drops a field or the env-interpolated value fails to reach the
 * spawned child.
 *
 * Adapter-mode coverage builds a tmp directory shaped `<dir>/dist/server.js`
 * (the convention resolve.ts enforces) by symlinking the mock server under
 * that path. Direct-mode coverage points command/args straight at the mock.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

import { loadConfig, spawnFromResolved } from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(HERE, "fixtures/mock-mcpaql-server.mjs");

let workdir;
let cfgPath;

beforeEach(async () => {
	workdir = await mkdtemp(join(tmpdir(), "mcpaql-entry-"));
	cfgPath = join(workdir, "mcpaql.config.json");
});

afterEach(async () => {
	await rm(workdir, { recursive: true, force: true });
});

async function writeCfg(obj) {
	await writeFile(cfgPath, JSON.stringify(obj, null, 2));
}

test("direct-mode: loadConfig → spawnFromResolved → introspect round-trips", async () => {
	await writeCfg({
		servers: [
			{
				name: "mock",
				direct: true,
				command: "node",
				args: [MOCK],
				trust: "developer",
				endpointMode: "multi",
			},
		],
	});

	const r = await loadConfig(cfgPath);
	assert.equal(r.servers.length, 1);
	assert.equal(r.servers[0].kind, "direct");

	const host = await spawnFromResolved(r.servers[0]);
	try {
		const response = await host.call("read", "introspect", {});
		assert.equal(response.success, true);
		assert.ok(Array.isArray(response.data?.operations));
		assert.equal(host.serverName, "mock");
	} finally {
		await host.close();
	}
});

test("adapter-mode (local path): loadConfig → resolveAdapter → spawnHost round-trips", async () => {
	// resolve.ts enforces `<dir>/dist/server.js` as the entry. Build a tmp
	// directory shaped that way using a symlink to the mock so we don't
	// duplicate the fixture on disk.
	const adapterDir = join(workdir, "adapter");
	await mkdir(join(adapterDir, "dist"), { recursive: true });
	await symlink(MOCK, join(adapterDir, "dist", "server.js"));

	await writeCfg({
		servers: [
			{
				name: "mockadapter",
				adapter: adapterDir,
				trust: "user",
				endpointMode: "multi",
			},
		],
	});

	const r = await loadConfig(cfgPath);
	assert.equal(r.servers.length, 1);
	assert.equal(r.servers[0].kind, "adapter");

	const host = await spawnFromResolved(r.servers[0]);
	try {
		const response = await host.call("read", "introspect", {});
		assert.equal(response.success, true);
		assert.ok(Array.isArray(response.data?.operations));
	} finally {
		await host.close();
	}
});

test("env interpolation flows from config through spawn into the child process", async () => {
	// Set a process env var, reference it from the config via ${env:VAR},
	// pass it through as a child-side env var under a different name, and
	// have the child echo it back. This exercises the full chain:
	//   process.env.SOURCE  → config env "OBSERVED": "${env:SOURCE}"
	//                       → loadConfig interpolates
	//                       → spawnFromResolved passes env to spawnHost
	//                       → child sees process.env.OBSERVED
	const SENTINEL = "entrypoint-test-sentinel-9d3e";
	process.env.MCPAQL_ENTRY_TEST_SOURCE = SENTINEL;

	try {
		await writeCfg({
			servers: [
				{
					name: "mock",
					direct: true,
					command: "node",
					args: [MOCK],
					env: { OBSERVED: "${env:MCPAQL_ENTRY_TEST_SOURCE}" },
					trust: "developer",
					endpointMode: "multi",
				},
			],
		});

		const r = await loadConfig(cfgPath);
		assert.equal(r.servers[0].env.OBSERVED, SENTINEL, "loader interpolated value");

		const host = await spawnFromResolved(r.servers[0]);
		try {
			const response = await host.call("read", "echo_env", { var: "OBSERVED" });
			assert.equal(response.success, true);
			assert.equal(
				response.data.value,
				SENTINEL,
				"spawned child saw the interpolated env value",
			);
		} finally {
			await host.close();
		}
	} finally {
		delete process.env.MCPAQL_ENTRY_TEST_SOURCE;
	}
});
