/**
 * Tests for the config loader: missing files, malformed JSON, schema
 * validation, env interpolation, defaults, duplicate names.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

import { ConfigError, loadConfig } from "../dist/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

let workdir;
let cfgPath;

beforeEach(async () => {
	workdir = await mkdtemp(join(tmpdir(), "mcpaql-cfg-"));
	cfgPath = join(workdir, "mcpaql.config.json");
});

afterEach(async () => {
	await rm(workdir, { recursive: true, force: true });
});

async function writeCfg(obj) {
	await writeFile(cfgPath, JSON.stringify(obj, null, 2));
}

test("missing config file → empty servers + soft notice, no error", async () => {
	const r = await loadConfig(join(workdir, "does-not-exist.json"));
	assert.equal(r.loaded, false);
	assert.deepEqual(r.servers, []);
	assert.equal(r.notices.length, 1);
	assert.match(r.notices[0], /No config file at/);
});

test("malformed JSON throws ConfigError with file path", async () => {
	await writeFile(cfgPath, "{ this is not json");
	await assert.rejects(
		loadConfig(cfgPath),
		(err) => err instanceof ConfigError && err.configPath === cfgPath && /Malformed JSON/.test(err.message),
	);
});

test("missing required field → ConfigError mentions the field", async () => {
	await writeCfg({ servers: [{ name: "foo", direct: true }] }); // missing command
	await assert.rejects(loadConfig(cfgPath), (err) => err instanceof ConfigError && /must match exactly one schema in oneOf|command/.test(err.message));
});

test("server with neither direct nor adapter → ConfigError (oneOf)", async () => {
	await writeCfg({ servers: [{ name: "foo", command: "x" }] });
	await assert.rejects(loadConfig(cfgPath), ConfigError);
});

test("server with both direct and adapter → ConfigError", async () => {
	await writeCfg({ servers: [{ name: "foo", direct: true, command: "x", adapter: "y" }] });
	await assert.rejects(loadConfig(cfgPath), ConfigError);
});

test("invalid name (uppercase) → ConfigError", async () => {
	await writeCfg({ servers: [{ name: "Foo", direct: true, command: "x" }] });
	await assert.rejects(loadConfig(cfgPath), ConfigError);
});

test("duplicate server names → ConfigError listing the duplicate", async () => {
	await writeCfg({
		servers: [
			{ name: "dup", direct: true, command: "a" },
			{ name: "dup", direct: true, command: "b" },
		],
	});
	await assert.rejects(
		loadConfig(cfgPath),
		(err) => err instanceof ConfigError && /Duplicate server name "dup"/.test(err.message),
	);
});

test("valid direct config → kind=direct with defaults applied", async () => {
	await writeCfg({
		servers: [
			{
				name: "dollhouse",
				direct: true,
				command: "npx",
				args: ["@dollhousemcp/mcp-server"],
			},
		],
	});
	const r = await loadConfig(cfgPath);
	assert.equal(r.loaded, true);
	assert.equal(r.servers.length, 1);
	const s = r.servers[0];
	assert.equal(s.kind, "direct");
	assert.equal(s.name, "dollhouse");
	assert.equal(s.command, "npx");
	assert.deepEqual(s.args, ["@dollhousemcp/mcp-server"]);
	assert.equal(s.transport, "stdio");
	assert.equal(s.trust, "user");
	assert.equal(s.endpointMode, "multi");
	assert.deepEqual(s.env, {});
});

test("valid adapter config → kind=adapter with defaults applied", async () => {
	await writeCfg({
		servers: [
			{
				name: "github",
				adapter: "@mcpaql/generated-github-mcp",
			},
		],
	});
	const r = await loadConfig(cfgPath);
	assert.equal(r.servers[0].kind, "adapter");
	assert.equal(r.servers[0].adapter, "@mcpaql/generated-github-mcp");
	assert.equal(r.servers[0].trust, "user");
	assert.equal(r.servers[0].endpointMode, "multi");
});

test("explicit trust / endpointMode override defaults", async () => {
	await writeCfg({
		servers: [
			{
				name: "dollhouse",
				direct: true,
				command: "x",
				trust: "developer",
				endpointMode: "unified",
			},
		],
	});
	const r = await loadConfig(cfgPath);
	assert.equal(r.servers[0].trust, "developer");
	assert.equal(r.servers[0].endpointMode, "unified");
});

test("${env:VAR} interpolation expands when var is set", async () => {
	const original = process.env.MCPAQL_TEST_TOKEN;
	process.env.MCPAQL_TEST_TOKEN = "secret-value";
	try {
		await writeCfg({
			servers: [
				{
					name: "github",
					adapter: "x",
					env: { TOKEN: "${env:MCPAQL_TEST_TOKEN}" },
				},
			],
		});
		const r = await loadConfig(cfgPath);
		assert.equal(r.servers[0].env.TOKEN, "secret-value");
		assert.equal(r.notices.length, 0);
	} finally {
		if (original === undefined) delete process.env.MCPAQL_TEST_TOKEN;
		else process.env.MCPAQL_TEST_TOKEN = original;
	}
});

test("${env:VAR} interpolation falls back to empty + notice when unset", async () => {
	delete process.env.MCPAQL_DEFINITELY_NOT_SET;
	await writeCfg({
		servers: [
			{
				name: "github",
				adapter: "x",
				env: { TOKEN: "${env:MCPAQL_DEFINITELY_NOT_SET}" },
			},
		],
	});
	const r = await loadConfig(cfgPath);
	assert.equal(r.servers[0].env.TOKEN, "");
	assert.equal(r.notices.length, 1);
	assert.match(r.notices[0], /MCPAQL_DEFINITELY_NOT_SET is unset/);
});

test("multiple ${env:VAR} substitutions in one value", async () => {
	process.env.MCPAQL_TEST_A = "alpha";
	process.env.MCPAQL_TEST_B = "beta";
	try {
		await writeCfg({
			servers: [
				{
					name: "x",
					adapter: "y",
					env: { COMBO: "${env:MCPAQL_TEST_A}-${env:MCPAQL_TEST_B}" },
				},
			],
		});
		const r = await loadConfig(cfgPath);
		assert.equal(r.servers[0].env.COMBO, "alpha-beta");
	} finally {
		delete process.env.MCPAQL_TEST_A;
		delete process.env.MCPAQL_TEST_B;
	}
});

test("empty servers array is allowed", async () => {
	await writeCfg({ servers: [] });
	const r = await loadConfig(cfgPath);
	assert.equal(r.loaded, true);
	assert.deepEqual(r.servers, []);
});

test("unknown top-level field is rejected (additionalProperties: false)", async () => {
	await writeCfg({ servers: [], extras: {} });
	await assert.rejects(loadConfig(cfgPath), ConfigError);
});

test("unknown server field is rejected (additionalProperties: false)", async () => {
	await writeCfg({
		servers: [{ name: "foo", direct: true, command: "x", bogus: 1 }],
	});
	await assert.rejects(loadConfig(cfgPath), ConfigError);
});

test("examples/mcpaql.config.example.json parses against MCPAQL_CONFIG_SCHEMA", async () => {
	// Catches drift between the documented example and the loader's schema —
	// the README walkthrough copies this file into ~/.pi/, so it must stay
	// schema-valid even though the github adapter path is a placeholder.
	const examplePath = join(REPO_ROOT, "examples", "mcpaql.config.example.json");
	const r = await loadConfig(examplePath);
	assert.equal(r.loaded, true);
	assert.equal(r.servers.length, 2);

	const dollhouse = r.servers.find((s) => s.name === "dollhouse");
	assert.ok(dollhouse, "expected a 'dollhouse' server in the example");
	assert.equal(dollhouse.kind, "direct");
	assert.equal(dollhouse.command, "npx");
	assert.deepEqual(dollhouse.args, ["--yes", "@dollhousemcp/mcp-server"]);
	assert.equal(dollhouse.trust, "developer");
	assert.equal(dollhouse.endpointMode, "multi");

	const github = r.servers.find((s) => s.name === "github");
	assert.ok(github, "expected a 'github' server in the example");
	assert.equal(github.kind, "adapter");
});

test("dollhouse direct-mode shape from the README parses as documented", async () => {
	// Locks in the canonical dollhouse direct-mode block. If the README's
	// quick-start snippet drifts from what the loader accepts, this fails
	// before users hit the loader's error path.
	await writeCfg({
		servers: [
			{
				name: "dollhouse",
				transport: "stdio",
				command: "npx",
				args: ["--yes", "@dollhousemcp/mcp-server"],
				direct: true,
				trust: "developer",
				endpointMode: "multi",
			},
		],
	});
	const r = await loadConfig(cfgPath);
	assert.equal(r.servers.length, 1);
	const s = r.servers[0];
	assert.equal(s.kind, "direct");
	assert.equal(s.name, "dollhouse");
	assert.equal(s.transport, "stdio");
	assert.equal(s.command, "npx");
	assert.deepEqual(s.args, ["--yes", "@dollhousemcp/mcp-server"]);
	assert.equal(s.trust, "developer");
	assert.equal(s.endpointMode, "multi");
});
