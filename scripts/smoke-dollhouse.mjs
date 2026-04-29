#!/usr/bin/env node
/**
 * Smoke-tests the bridge against a live DollhouseMCP server (direct mode).
 *
 * DollhouseMCP speaks MCP-AQL natively, so no adapter is needed — spawnHost
 * talks straight to its mcp_aql_* tools. This script spawns it via npx,
 * calls read/introspect, prints the operations list, and exits 0 on success.
 *
 * Not run in CI — depends on the npm registry and pulls a several-MB package
 * the first time. Run it manually after wiring changes:
 *
 *   npm run smoke:dollhouse
 *
 * Environment:
 *   DOLLHOUSE_PKG  — override the pinned package spec (default below)
 *
 * The default is pinned to the version that produced the captured
 * conformance fixture (test/fixtures/dollhouse-introspect.json) so smoke
 * output stays in sync with the fixture by default. Use DOLLHOUSE_PKG to
 * smoke against `@latest` before bumping the fixture.
 */
//
// Expected shape of a healthy run (truncated). Note operation summaries
// use `element_name` rather than the spec's `name` — that's the dollhouse
// conformance gap pinned by test/conformance-dollhouse.test.mjs (#23).
//   {
//     "success": true,
//     "data": {
//       "operations": [
//         { "element_name": "list_elements", "endpoint": "READ", ... },
//         ...
//       ]
//     }
//   }

import { spawnHost } from "../dist/host.js";

const DEFAULT_PKG = "@dollhousemcp/mcp-server@2.0.32";
const PKG = process.env.DOLLHOUSE_PKG ?? DEFAULT_PKG;

const config = {
	name: "dollhouse",
	command: "npx",
	args: ["--yes", PKG],
};

async function main() {
	console.log(`[smoke] package spec: ${PKG}${PKG === DEFAULT_PKG ? "" : " (overridden via DOLLHOUSE_PKG)"}`);
	console.log(`[smoke] spawning ${config.name} via npx…`);
	const host = await spawnHost(config);
	console.log(`[smoke] connected. calling read/introspect…`);

	try {
		const response = await host.call("read", "introspect", { query: "operations" });
		const json = JSON.stringify(response, null, 2);
		// Print full response so a maintainer can spot-check shape regressions.
		console.log(`[smoke] response:\n${json}`);

		if (!response.success) {
			console.error(`[smoke] FAIL — response.success=false`);
			process.exitCode = 1;
			return;
		}

		const data = /** @type {{ operations?: unknown[] }} */ (response.data);
		const ops = Array.isArray(data?.operations) ? data.operations : [];
		if (ops.length === 0) {
			console.error(`[smoke] FAIL — operations array is empty`);
			process.exitCode = 1;
			return;
		}
		console.log(`[smoke] OK — ${ops.length} operations advertised.`);
	} finally {
		await host.close();
	}
}

main().catch((err) => {
	console.error(`[smoke] threw:`, err);
	process.exit(1);
});
