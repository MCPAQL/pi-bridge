/**
 * Structured errors thrown by registered tools when the upstream MCP-AQL
 * server returns `{ success: false, error: {...} }`. Pi's tool runtime
 * surfaces `error.message` to the model and logs, so we format `.message`
 * with the structured code prefix `[CODE] message` for at-a-glance
 * readability — but the original `code`, `details`, and (for the
 * CONFIRMATION_REQUIRED case) `confirmation` envelope are preserved on
 * the instance so any caller that wants to introspect (custom Pi
 * extensions, the eventual confirmation flow in #8, downstream observers)
 * can pull them off without re-parsing the message string.
 *
 * Class hierarchy:
 *   BridgeToolError                — generic upstream failure
 *     └─ ConfirmationRequiredError — code=CONFIRMATION_REQUIRED + envelope
 *
 * The subclass guarantees a non-undefined `confirmation`, so #8's retry
 * flow can `if (err instanceof ConfirmationRequiredError) { … err.confirmation.token … }`
 * without null-checks. The `requiresConfirmation` getter on the base
 * class is a convenience for consumers that don't want to import the
 * subclass — it just delegates to `instanceof`.
 */

import type { CrudeConfirmation } from "./host.js";

export class BridgeToolError extends Error {
	// Typed as string (not the literal) so subclasses can override with
	// their own name without TS2416 narrowing complaints.
	readonly name: string = "BridgeToolError";
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
	 * False on the base class; ConfirmationRequiredError overrides to
	 * true. Convenience for consumers that don't want to import the
	 * subclass — #8's retry flow should still prefer
	 * `instanceof ConfirmationRequiredError` since that narrows
	 * `confirmation` to non-undefined.
	 */
	get requiresConfirmation(): boolean {
		return false;
	}
}

/**
 * Thrown when the upstream returns code=CONFIRMATION_REQUIRED with a
 * usable confirmation envelope. The non-optional `confirmation` field
 * (overriding the base class's optional one) lets #8 pull `token` and
 * `expires_at` without null-checks inside an `instanceof` branch.
 */
export class ConfirmationRequiredError extends BridgeToolError {
	override readonly name: string = "ConfirmationRequiredError";
	// The base class declares `confirmation?: CrudeConfirmation`; the
	// override narrows to non-optional. The reassignment in the
	// constructor below (after `super(...)` already set it) is what
	// actually makes the narrowed type hold at runtime — required pattern,
	// not dead code.
	override readonly confirmation: CrudeConfirmation;

	constructor(args: {
		message: string;
		details?: unknown;
		confirmation: CrudeConfirmation;
		server: string;
		verb: string;
		operation: string;
	}) {
		super({
			code: "CONFIRMATION_REQUIRED",
			message: args.message,
			details: args.details,
			confirmation: args.confirmation,
			server: args.server,
			verb: args.verb,
			operation: args.operation,
		});
		this.confirmation = args.confirmation;
	}

	override get requiresConfirmation(): boolean {
		return true;
	}
}
