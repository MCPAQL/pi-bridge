/**
 * Shared internal utilities. Not part of the public API surface.
 */

/**
 * Type guard for Node.js filesystem errors. Narrows `unknown` to
 * `NodeJS.ErrnoException` so callers can branch on `.code`.
 */
export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
