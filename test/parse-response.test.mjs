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
