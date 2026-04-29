/**
 * @mcpaql/pi-bridge — Pi extension entrypoint.
 *
 * Hosts one or more MCP-AQL adapters configured via ~/.pi/mcpaql.config.json
 * and registers their CRUDE operations as per-server Pi tools.
 *
 * Walking-skeleton placeholder. See https://github.com/MCPAQL/pi-bridge/issues.
 */

// Pi types are loaded by the host at runtime; we type against them via peer dependency.
// Importing only the type avoids a hard runtime dependency during initial scaffolding.
type ExtensionAPI = unknown;

export default async function piBridge(_pi: ExtensionAPI): Promise<void> {
	// Implementation lands incrementally via the issues filed against this repo.
}
