#!/usr/bin/env node
/**
 * Manual end-to-end smoke for the entrypoint chain.
 *
 * Loads `examples/mcpaql.config.example.json` unchanged, runs each resolved
 * server through `spawnFromResolved`, calls `read/introspect` on the host,
 * and prints a per-server summary. Exits non-zero if any server fails to
 * spawn or returns an unsuccessful introspection.
 *
 * Not CI-gated — depends on live npm + the dollhouse package (the example
 * config ships with a pinned dollhouse direct-mode entry).
 *
 *   npm run smoke:entrypoint
 *
 * The CI-gated equivalent (mock server, no network) lives in
 * test/entrypoint.test.mjs.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, spawnFromResolved } from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PATH = resolve(HERE, "..", "examples", "mcpaql.config.example.json");

async function main() {
	console.log(`[smoke] loading config: ${EXAMPLE_PATH}`);
	const r = await loadConfig(EXAMPLE_PATH);
	console.log(`[smoke] loaded ${r.servers.length} server(s); notices: ${r.notices.length}`);
	for (const note of r.notices) console.log(`[smoke]   notice: ${note}`);

	if (r.servers.length === 0) {
		console.error("[smoke] FAIL — example config has no servers to spawn");
		process.exit(1);
	}

	let failures = 0;
	for (const server of r.servers) {
		console.log(`\n[smoke] --- ${server.name} (${server.kind}) ---`);
		try {
			const host = await spawnFromResolved(server);
			try {
				const response = await host.call("read", "introspect", { query: "operations" });
				if (!response.success) {
					console.error(
						`[smoke] FAIL ${server.name}: introspect.success=false err=${JSON.stringify(response.error)}`,
					);
					failures += 1;
					continue;
				}
				const ops = Array.isArray(response.data?.operations) ? response.data.operations : [];
				console.log(`[smoke] OK ${server.name}: ${ops.length} operations advertised`);
			} finally {
				await host.close();
			}
		} catch (err) {
			console.error(`[smoke] FAIL ${server.name}: ${err instanceof Error ? err.message : String(err)}`);
			failures += 1;
		}
	}

	if (failures > 0) {
		console.error(`\n[smoke] ${failures} server(s) failed.`);
		process.exit(1);
	}
	console.log(`\n[smoke] OK — all ${r.servers.length} server(s) responded.`);
}

main().catch((err) => {
	console.error(`[smoke] threw:`, err);
	process.exit(1);
});
