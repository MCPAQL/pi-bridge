# Conformance assets

Vendored copies of MCP-AQL JSON Schemas from
[MCPAQL/spec](https://github.com/MCPAQL/spec) used by
`test/conformance.test.mjs` to assert that responses flowing through the
bridge match the spec's discriminated-union shape.

## Sync state

| Schema | Source | Synced at |
|---|---|---|
| `operation-result.schema.json` | `spec/schemas/operation-result.schema.json` | spec @ `5264015` |
| `introspection-response.schema.json` | `spec/schemas/introspection-response.schema.json` | spec @ `5264015` |

## Resyncing

When the spec moves, run from the repo root:

```bash
cp ../spec/schemas/operation-result.schema.json conformance/schemas/
cp ../spec/schemas/introspection-response.schema.json conformance/schemas/
git -C ../spec rev-parse --short HEAD   # update the table above
```

A scheduled remote agent that does this and opens a PR when the spec
changes is a natural follow-up once spec ships its conformance harness
as an npm package.

## Why vendor?

Spec is `private: true` (not on npm). Pinning a vendored copy with a
commit hash gives CI a deterministic schema target, and a diff in
this directory is the obvious signal that the bridge needs to be
re-validated against a moving spec.
