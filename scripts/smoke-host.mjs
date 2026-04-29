#!/usr/bin/env node
/**
 * Smoke-tests the bridge's MCP host against the local github adapter.
 * Spawns the adapter, calls `read` with operation="introspect" — which is
 * schema-driven on the adapter side and does not require a live GitHub call.
 *
 * Usage: node scripts/smoke-host.mjs
 */

import { spawnHost } from "../dist/host.js";

const ADAPTER_PATH =
	"/Users/mick/Developer/Organizations/MCPAQL/examples/generated/github-mcp/adapter/dist/server.js";

const config = {
	name: "github",
	transport: "stdio",
	command: "node",
	args: [ADAPTER_PATH],
	env: {
		GITHUB_PERSONAL_ACCESS_TOKEN:
			process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? process.env.GITHUB_TOKEN ?? "",
	},
	trust: "user",
	endpointMode: "multi",
};

async function main() {
	console.log(`[smoke] spawning ${config.name} adapter…`);
	const host = await spawnHost(config);
	console.log(`[smoke] connected. calling read/introspect…`);

	try {
		const response = await host.call("read", "introspect", { query: "operations" });
		console.log(`[smoke] response:`, JSON.stringify(response, null, 2).slice(0, 2000));
		if (!response.success) {
			console.error(`[smoke] FAIL — response.success=false`);
			process.exitCode = 1;
		} else {
			console.log(`[smoke] OK — walking skeleton walks.`);
		}
	} finally {
		await host.close();
	}
}

main().catch((err) => {
	console.error(`[smoke] threw:`, err);
	process.exit(1);
});
