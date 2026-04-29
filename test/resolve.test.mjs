/**
 * Tests for resolveAdapter: turns an adapter spec string into the
 * {command, args} the host needs to spawn.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("permission denied on entry → distinguishes EACCES from missing file", async (t) => {
	// chmod 000 on a file makes access(F_OK) succeed but access(R_OK) fail
	// on POSIX — node's fs/promises access checks F_OK by default, so to
	// trigger EACCES we need to drop permissions on the parent directory
	// instead. CI runners running as root bypass perms entirely; skip there.
	if (process.getuid && process.getuid() === 0) {
		t.skip("skipped: running as root, perms bypassed");
		return;
	}
	const dir = await makeAdapterDir(workdir);
	const distDir = join(dir, "dist");
	await chmod(distDir, 0o000);
	try {
		await assert.rejects(
			resolveAdapter(adapterConfig(dir)),
			(err) =>
				err instanceof Error &&
				/permission denied/i.test(err.message) &&
				err.message.includes(join(dir, "dist", "server.js")),
		);
	} finally {
		// Restore perms so afterEach's rm() can clean up.
		await chmod(distDir, 0o755);
	}
});

test("relative ../path also routes through local resolution", async () => {
	// "../something" is a valid local-path prefix per isLocalPath. We don't
	// need to construct a real ../something test fixture; the assertion is
	// that the spec is recognized as a local path and produces a path-based
	// error (not handed off to npx).
	await assert.rejects(
		resolveAdapter(adapterConfig("../never-exists-mcpaql-test")),
		(err) =>
			err instanceof Error &&
			/expected/.test(err.message) &&
			err.message.includes(join("dist", "server.js")),
	);
});

test("relative ./path resolves against cwd", async () => {
	// chdir is a global side effect, but node:test runs tests sequentially
	// within a file by default, so this is safe as long as the finally block
	// always restores the original cwd. If the test runner ever moves to
	// concurrent-within-file execution, this needs a different approach
	// (e.g., a relative-path helper that takes an explicit base directory).
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

test("bare ~ expands to homedir", async () => {
	// Resolves "~" by itself (not "~/something") to the home directory,
	// then tries to find dist/server.js inside it. We don't expect a real
	// adapter at homedir(), so this asserts on the helpful error message.
	await assert.rejects(
		resolveAdapter(adapterConfig("~")),
		(err) => err instanceof Error && err.message.includes(join(homedir(), "dist", "server.js")),
	);
});

test("~/path expands to homedir + path", async () => {
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

test("version-pinned scoped package @scope/name@1.2.3 → npx --yes (passes regex check)", async () => {
	const r = await resolveAdapter(adapterConfig("@mcpaql/foo@2.1.0"));
	assert.equal(r.command, "npx");
	assert.deepEqual(r.args, ["--yes", "@mcpaql/foo@2.1.0"]);
});

test("version-pinned unscoped package pkg@1.0.0 → npx --yes", async () => {
	const r = await resolveAdapter(adapterConfig("some-package@1.0.0"));
	assert.equal(r.command, "npx");
	assert.deepEqual(r.args, ["--yes", "some-package@1.0.0"]);
});

test("ambiguous unrooted path-like spec → throws with explicit guidance", async () => {
	// "adapters/my-server" looks like a relative path but isn't rooted with
	// ./, ../, ~/, or /. Without rejection, this would silently resolve to
	// `npx adapters/my-server`, which is almost never what the user meant.
	await assert.rejects(
		resolveAdapter(adapterConfig("adapters/my-server")),
		(err) =>
			err instanceof Error &&
			/looks like a path but isn't rooted/.test(err.message) &&
			/Prefix with "\.\/"/.test(err.message),
	);
});

test("multi-segment scoped-package-shaped spec is also ambiguous", async () => {
	// @scope/pkg is fine; @scope/pkg/extra is not a valid npm name, so we
	// shouldn't quietly hand it to npx.
	await assert.rejects(
		resolveAdapter(adapterConfig("@scope/pkg/extra")),
		(err) => err instanceof Error && /looks like a path but isn't rooted/.test(err.message),
	);
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
