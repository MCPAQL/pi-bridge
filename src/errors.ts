/**
 * Structured error thrown by registered tools when the upstream MCP-AQL
 * server returns `{ success: false, error: {...} }`. Pi's tool runtime
 * surfaces `error.message` to the model and logs, so we format `.message`
 * with the structured code prefix `[CODE] message` for at-a-glance
 * readability — but the original `code`, `details`, and (for the
 * CONFIRMATION_REQUIRED case) `confirmation` envelope are preserved on
 * the instance so any caller that wants to introspect (custom Pi
 * extensions, the eventual confirmation flow in #8, downstream observers)
 * can pull them off without re-parsing the message string.
 */

import type { CrudeConfirmation } from "./host.js";

export class BridgeToolError extends Error {
	readonly name = "BridgeToolError";
	readonly code: string;
	readonly details?: unknown;
	readonly confirmation?: CrudeConfirmation;
	readonly server: string;
	readonly verb: string;
	readonly operation: string;

	constructor(args: {
		code: string;
		message: string;
		details?: unknown;
		confirmation?: CrudeConfirmation;
		server: string;
		verb: string;
		operation: string;
	}) {
		super(`[${args.code}] ${args.message}`);
		this.code = args.code;
		this.details = args.details;
		this.confirmation = args.confirmation;
		this.server = args.server;
		this.verb = args.verb;
		this.operation = args.operation;
	}

	/**
	 * True when the upstream signaled CONFIRMATION_REQUIRED with a usable
	 * confirmation envelope. The retry flow lives in #8; today this just
	 * gives consumers (and #8) a single boolean to gate on.
	 */
	get requiresConfirmation(): boolean {
		return this.code === "CONFIRMATION_REQUIRED" && this.confirmation !== undefined;
	}
}
