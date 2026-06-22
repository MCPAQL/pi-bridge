/**
 * Pure unit tests for parseCrudeResponse: covers structuredContent preference,
 * text-frame JSON fallback, isError surfacing, and malformed-response
 * defaults. No subprocess required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCrudeResponse } from "../dist/host.js";

test("prefers structuredContent over text frame when both are present", () => {
	const r = parseCrudeResponse({
		structuredContent: { success: true, data: { x: 1 } },
		content: [{ type: "text", text: '{"success":false,"error":{"code":"X","message":"y"}}' }],
	});
	assert.deepEqual(r, { success: true, data: { x: 1 } });
});

test("falls back to first text content frame as JSON", () => {
	const r = parseCrudeResponse({
		content: [{ type: "text", text: '{"success":true,"data":42}' }],
	});
	assert.deepEqual(r, { success: true, data: 42 });
});

test("surfaces UPSTREAM_ERROR when isError but payload is unparseable", () => {
	const r = parseCrudeResponse({ content: [{ type: "image" }], isError: true });
	assert.equal(r.success, false);
	assert.equal(r.error.code, "UPSTREAM_ERROR");
});

test("surfaces MALFORMED_RESPONSE when text frame is not JSON", () => {
	const r = parseCrudeResponse({ content: [{ type: "text", text: "not json at all" }] });
	assert.equal(r.success, false);
	assert.equal(r.error.code, "MALFORMED_RESPONSE");
});

test("surfaces MALFORMED_RESPONSE when content is missing entirely", () => {
	const r = parseCrudeResponse({});
	assert.equal(r.success, false);
	assert.equal(r.error.code, "MALFORMED_RESPONSE");
});

test("surfaces MALFORMED_RESPONSE for null/undefined input", () => {
	const r1 = parseCrudeResponse(null);
	assert.equal(r1.success, false);
	const r2 = parseCrudeResponse(undefined);
	assert.equal(r2.success, false);
});

test("extracts warnings array on success when shape is well-formed", () => {
	const r = parseCrudeResponse({
		structuredContent: {
			success: true,
			data: { ok: 1 },
			warnings: [
				{ code: "DEPRECATED_FIELD", message: "use new_field" },
				{
					code: "PARTIAL_RESULT",
					message: "stopped at 1000",
					severity: "medium",
					details: { count: 1000 },
				},
			],
		},
	});
	assert.equal(r.success, true);
	assert.equal(r.warnings?.length, 2);
	assert.equal(r.warnings[0].code, "DEPRECATED_FIELD");
	assert.equal(r.warnings[1].severity, "medium");
	assert.deepEqual(r.warnings[1].details, { count: 1000 });
});

test("rejects array-shaped warning details (spec says type:object)", () => {
	// Regression: typeof [] === "object" used to pass the parseWarnings
	// guard, letting an array slip in as Record<string, unknown>. The spec
	// says details is an object, not an array.
	const r = parseCrudeResponse({
		structuredContent: {
			success: true,
			data: {},
			warnings: [{ code: "ARRAY_DETAILS", message: "test", details: [1, 2, 3] }],
		},
	});
	assert.equal(r.warnings?.length, 1);
	assert.equal(r.warnings[0].details, undefined);
});

test("drops malformed warnings entries silently, keeps valid ones", () => {
	const r = parseCrudeResponse({
		structuredContent: {
			success: true,
			data: {},
			warnings: [
				{ code: "OK", message: "kept" },
				{ code: "no message" },
				"not even an object",
				{ message: "no code" },
				null,
			],
		},
	});
	assert.equal(r.warnings?.length, 1);
	assert.equal(r.warnings[0].code, "OK");
});

test("omits warnings field entirely when array is empty or missing", () => {
	const a = parseCrudeResponse({ structuredContent: { success: true, data: {}, warnings: [] } });
	assert.equal("warnings" in a, false);
	const b = parseCrudeResponse({ structuredContent: { success: true, data: {} } });
	assert.equal("warnings" in b, false);
});

test("extracts confirmation envelope on CONFIRMATION_REQUIRED failure", () => {
	const r = parseCrudeResponse({
		structuredContent: {
			success: false,
			error: { code: "CONFIRMATION_REQUIRED", message: "needs approval" },
			confirmation: {
				token: "tok-abc",
				expires_at: "2026-04-29T20:00:00Z",
				message: "delete 47 records?",
				reasons: ["destructive"],
			},
		},
	});
	assert.equal(r.success, false);
	assert.equal(r.confirmation?.token, "tok-abc");
	assert.deepEqual(r.confirmation?.reasons, ["destructive"]);
});

test("drops malformed confirmation envelope (missing token) but preserves error", () => {
	const r = parseCrudeResponse({
		structuredContent: {
			success: false,
			error: { code: "CONFIRMATION_REQUIRED", message: "needs approval" },
			confirmation: { expires_at: "2026-04-29T20:00:00Z" },
		},
	});
	assert.equal(r.success, false);
	assert.equal(r.error.code, "CONFIRMATION_REQUIRED");
	assert.equal(r.confirmation, undefined);
});
