/**
 * Spec-conformance tests: validates the discriminated-union shape of every
 * response that flows through the bridge against the vendored MCPAQL/spec
 * JSON Schemas. Catches regressions where parseCrudeResponse, the host's
 * MCP plumbing, or the mock fixture drifts from the spec.
 *
 * The schemas are vendored at conformance/schemas/ — see conformance/README.md
 * for the sync table and resync procedure.
 */

import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { spawnHost } from "../dist/host.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MOCK = resolve(HERE, "fixtures/mock-mcpaql-server.mjs");

const ajv = new Ajv2020.default({ strict: false, allErrors: true });
addFormats.default(ajv);

const operationResultSchema = JSON.parse(
	await readFile(resolve(ROOT, "conformance/schemas/operation-result.schema.json"), "utf8"),
);
const introspectionResponseSchema = JSON.parse(
	await readFile(resolve(ROOT, "conformance/schemas/introspection-response.schema.json"), "utf8"),
);

// Compile the introspection schema first so operation-result can resolve any
// cross-schema $refs if the spec ever adds them. (Today it doesn't, but
// registering both makes the harness future-proof.)
ajv.addSchema(introspectionResponseSchema);
const validateOperationResult = ajv.compile(operationResultSchema);
const validateIntrospectionResponse = ajv.compile(introspectionResponseSchema);

const baseConfig = {
	name: "mock",
	transport: "stdio",
	command: "node",
	args: [MOCK],
	trust: "user",
	endpointMode: "multi",
};

function assertValid(validator, value, label) {
	const ok = validator(value);
	if (!ok) {
		const errs = (validator.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join("; ");
		assert.fail(`${label} failed schema validation: ${errs}\nvalue: ${JSON.stringify(value)}`);
	}
}

test("introspect response conforms to operation-result + introspection-response schemas", async () => {
	const host = await spawnHost(baseConfig);
	try {
		const r = await host.call("read", "introspect", {});
		// operation-result.schema validates the {success, data|error} envelope.
		assertValid(validateOperationResult, r, "introspect operation-result");
		assert.equal(r.success, true);
		// introspection-response.schema also validates the full envelope but tightens
		// the data shape to one of OperationsListData / OperationDetailData / etc.
		assertValid(validateIntrospectionResponse, r, "introspect → introspection-response");
	} finally {
		await host.close();
	}
});

test("success responses across all five verbs conform to operation-result", async () => {
	const host = await spawnHost(baseConfig);
	try {
		for (const verb of ["create", "read", "update", "delete", "execute"]) {
			const r = await host.call(verb, "echo", { x: 1 });
			assertValid(validateOperationResult, r, `${verb}/echo`);
		}
	} finally {
		await host.close();
	}
});

test("error responses conform to operation-result (failure branch)", async () => {
	const host = await spawnHost(baseConfig);
	try {
		const r = await host.call("read", "fail_validation", {});
		assertValid(validateOperationResult, r, "fail_validation");
		assert.equal(r.success, false);
		assert.match(r.error.code, /^[A-Z][A-Z0-9_]*$/);
	} finally {
		await host.close();
	}
});

test("structuredContent-only and text-only paths both yield conformant responses", async () => {
	const host = await spawnHost(baseConfig);
	try {
		const sc = await host.call("read", "structured_only", {});
		assertValid(validateOperationResult, sc, "structured_only");
		const t = await host.call("read", "text_only", {});
		assertValid(validateOperationResult, t, "text_only");
	} finally {
		await host.close();
	}
});

test("synthetic MALFORMED_RESPONSE / UPSTREAM_ERROR shapes conform to operation-result", async () => {
	const { parseCrudeResponse } = await import("../dist/host.js");

	const malformed = parseCrudeResponse({});
	assertValid(validateOperationResult, malformed, "synthetic malformed");
	assert.equal(malformed.error.code, "MALFORMED_RESPONSE");

	const upstream = parseCrudeResponse({ content: [{ type: "image" }], isError: true });
	assertValid(validateOperationResult, upstream, "synthetic upstream error");
	assert.equal(upstream.error.code, "UPSTREAM_ERROR");
});
