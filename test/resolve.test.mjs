/**
 * Tests for resolveAdapter: turns an adapter spec string into the
 * {command, args} the host needs to spawn.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { resolveAdapter } from "../dist/resolve.js";

let workdir;

beforeEach(async () => {
	workdir = await mkdtemp(join(tmpdir(), "mcpaql-resolve-"));
});

afterEach(async () => {
	await rm(workdir, { recursive: true, force: true });
});

function adapterConfig(spec) {
	return {
		kind: "adapter",
		name: "test",
		transport: "stdio",
		trust: "user",
		endpointMode: "multi",
		adapter: spec,
		env: {},
	};
}

async function makeAdapterDir(root, hasServer = true) {
	const dir = join(root, "adapter");
	await mkdir(join(dir, "dist"), { recursive: true });
	if (hasServer) {
		await writeFile(join(dir, "dist", "server.js"), "// stub\n");
	}
	return dir;
}

test("absolute path with dist/server.js → node + entry path", async () => {
	const dir = await makeAdapterDir(workdir);
	const r = await resolveAdapter(adapterConfig(dir));
	assert.equal(r.command, "node");
	assert.deepEqual(r.args, [join(dir, "dist", "server.js")]);
});

test("absolute path with no dist/server.js → throws with the expected entry path", async () => {
	const dir = await makeAdapterDir(workdir, false);
	await assert.rejects(
		resolveAdapter(adapterConfig(dir)),
		(err) => err instanceof Error && err.message.includes(join(dir, "dist", "server.js")),
	);
});

test("relative ./path resolves against cwd", async () => {
	await makeAdapterDir(workdir);
	const cwd = process.cwd();
	process.chdir(workdir);
	try {
		const r = await resolveAdapter(adapterConfig("./adapter"));
		assert.equal(r.command, "node");
		// On macOS, mkdtemp returns a /var/folders/... path that path.resolve()
		// canonicalizes to /private/var/folders/..., so we can't compare exact
		// strings — assert on the trailing suffix and absolute-ness instead.
		assert.ok(r.args[0].endsWith(join("adapter", "dist", "server.js")));
		assert.ok(r.args[0].startsWith("/"));
	} finally {
		process.chdir(cwd);
	}
});

test("~ expands to homedir", async () => {
	// We can't actually create files in homedir, so we just check that the
	// path expansion produces a homedir-rooted entry — even if it doesn't
	// exist (the test asserts on the error message, not on success).
	await assert.rejects(
		resolveAdapter(adapterConfig("~/never-exists-mcpaql-test-path")),
		(err) => err instanceof Error && err.message.includes(join(homedir(), "never-exists-mcpaql-test-path", "dist", "server.js")),
	);
});

test("npm package name → npx --yes <package>", async () => {
	const r = await resolveAdapter(adapterConfig("@mcpaql/some-package"));
	assert.equal(r.command, "npx");
	assert.deepEqual(r.args, ["--yes", "@mcpaql/some-package"]);
});

test("plain (unscoped) npm package name → npx --yes <package>", async () => {
	const r = await resolveAdapter(adapterConfig("some-package"));
	assert.equal(r.command, "npx");
	assert.deepEqual(r.args, ["--yes", "some-package"]);
});

test("git: URL → throws not-yet-implemented with mention of #6", async () => {
	await assert.rejects(
		resolveAdapter(adapterConfig("git:github.com/user/repo@v1")),
		(err) =>
			err instanceof Error &&
			/git:/.test(err.message) &&
			/not yet implemented/.test(err.message) &&
			/#6/.test(err.message),
	);
});

test("git+... URL also rejected as not-yet-implemented", async () => {
	await assert.rejects(
		resolveAdapter(adapterConfig("git+https://github.com/user/repo.git")),
		(err) => err instanceof Error && /not yet implemented/.test(err.message),
	);
});
