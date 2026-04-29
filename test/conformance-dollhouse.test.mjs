/**
 * Spec-conformance check against a captured DollhouseMCP introspection
 * response. Validates two things:
 *
 *   1. The discriminated-response envelope (operation-result.schema) — must
 *      pass. The bridge relies on this shape; if it ever fails, dollhouse
 *      stopped being an MCP-AQL server and this is a hard regression.
 *
 *   2. The strict introspection-response.schema — currently FAILS for
 *      dollhouse. Operation summaries use `element_name` instead of the
 *      spec's `name`, which trips both `additionalProperties: false` and
 *      the `required: ["name", ...]` constraint on OperationInfo.
 *
 * Asserting both states pins the known conformance gap: when DollhouseMCP
 * closes it, this test fails noisily and signals "refresh the fixture and
 * flip the assertion." Tracked in the deferred conformance issue (#23).
 *
 * Fixture provenance: captured by `npm run smoke:dollhouse` against
 * `@dollhousemcp/mcp-server@2.0.32` on 2026-04-29. Re-capture with the
 * smoke script when bumping the dollhouse version.
 */

import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const AjvCtor = Ajv2020.default ?? Ajv2020;
const addFormatsFn = addFormats.default ?? addFormats;

const ajv = new AjvCtor({ strict: false, allErrors: true });
addFormatsFn(ajv);

const operationResultSchema = JSON.parse(
	await readFile(resolve(ROOT, "conformance/schemas/operation-result.schema.json"), "utf8"),
);
const introspectionResponseSchema = JSON.parse(
	await readFile(resolve(ROOT, "conformance/schemas/introspection-response.schema.json"), "utf8"),
);

const validateOperationResult = ajv.compile(operationResultSchema);
const validateIntrospectionResponse = ajv.compile(introspectionResponseSchema);

const fixture = JSON.parse(
	await readFile(resolve(HERE, "fixtures/dollhouse-introspect.json"), "utf8"),
);

test("dollhouse introspection envelope conforms to operation-result", () => {
	const ok = validateOperationResult(fixture);
	if (!ok) {
		const errs = (validateOperationResult.errors ?? [])
			.map((e) => `${e.instancePath} ${e.message}`)
			.join("; ");
		assert.fail(`envelope rejected by operation-result schema: ${errs}`);
	}
	assert.equal(fixture.success, true);
	assert.ok(Array.isArray(fixture.data?.operations), "expected operations array");
	assert.ok(fixture.data.operations.length > 0, "expected non-empty operations array");
});

test("dollhouse introspection currently fails strict introspection-response (documents gap)", () => {
	const ok = validateIntrospectionResponse(fixture);
	assert.equal(
		ok,
		false,
		"dollhouse introspection unexpectedly passed strict schema — refresh the fixture and flip this assertion (#23 closed?)",
	);

	const errors = validateIntrospectionResponse.errors ?? [];
	// At least one error must be about the OperationInfo shape — i.e. the
	// `element_name` / missing `name` divergence. If the failure mode shifts
	// to something else, that's also worth catching here.
	const operationInfoErrors = errors.filter((e) =>
		/operations/.test(e.instancePath ?? ""),
	);
	assert.ok(
		operationInfoErrors.length > 0,
		`expected schema errors on the operations array, got: ${JSON.stringify(errors)}`,
	);
});
