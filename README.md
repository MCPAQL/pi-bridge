# @mcpaql/pi-bridge

> Pi extension that bridges any MCP-AQL adapter (or natively-MCP-AQL server) into the [Pi coding agent](https://pi.dev/) as native Pi tools.

**Status:** Walking-skeleton in development. See [issues](https://github.com/MCPAQL/pi-bridge/issues) for the implementation plan.

## What this is

[Pi](https://pi.dev/) deliberately ships without built-in MCP support — it positions itself as primitives over features. That decision is sound, because raw MCP servers can dump 100+ tool schemas into context before any work begins.

[MCP-AQL](https://github.com/MCPAQL/spec) consolidates an MCP server's surface into 5 semantic CRUDE endpoints (Create, Read, Update, Delete, Execute) with introspection-on-demand. ~96% reduction in tool-definition tokens, measured on a 47-tool reference server.

This package is a Pi extension that hosts MCP-AQL adapters — the standard-conformant ones produced by [`@mcpaql/adapter-generator`](https://github.com/MCPAQL/adapter-generator) and the directly-MCP-AQL servers like [DollhouseMCP](https://github.com/DollhouseMCP/mcp-server) — and registers their CRUDE operations as Pi tools.

## How it works

```
┌──────────────────┐
│  Pi (TUI / SDK)  │
└────────┬─────────┘
         │  pi.registerTool(...)
┌────────┴─────────┐
│ @mcpaql/pi-bridge│  ← this package (Pi extension)
└────────┬─────────┘
         │  MCP stdio
   ┌─────┴──────┬──────────────┬────────────┐
   ▼            ▼              ▼            ▼
┌─────────┐ ┌─────────┐  ┌──────────┐ ┌──────────┐
│ MCP-AQL │ │ MCP-AQL │  │ MCP-AQL  │ │ Native   │
│ adapter │ │ adapter │  │ adapter  │ │ MCP-AQL  │
│ github  │ │playwrght│  │  …       │ │dollhouse │
└────┬────┘ └────┬────┘  └────┬─────┘ └────┬─────┘
     ▼           ▼            ▼            ▼
   GitHub    Playwright    Upstream     Dollhouse
   MCP svr   MCP svr       MCP svr      element runtime
```

The bridge is a **host**, not a router. Each wired server registers its own per-server set of Pi tools (`<server>_create`, `<server>_read`, …), so the LLM sees `dollhouse_read` and `github_read` as distinct surfaces. No global routing, no spec delta — adapters stay 1:1 with their upstreams as MCP-AQL specifies today.

## Configuration

Configured via `~/.pi/mcpaql.config.json`:

```jsonc
{
  "servers": [
    {
      "name": "dollhouse",
      "transport": "stdio",
      "command": "npx",
      "args": ["--yes", "@dollhousemcp/mcp-server"],
      "direct": true,
      "trust": "developer",
      "endpointMode": "multi"
    },
    {
      "name": "github",
      "adapter": "@mcpaql/generated-github-mcp",
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_TOKEN}" },
      "trust": "user",
      "endpointMode": "multi"
    }
  ]
}
```

- `direct: true` — server already speaks MCP-AQL natively; talk straight to its `mcp_aql_*` tools. Requires `command` and `args`.
- `adapter: "<spec>"` — wrap a non-MCP-AQL server with a generated adapter, then expose that. The spec recognizes three forms (see *Adapter spec forms* below).
- `endpointMode: "multi" | "unified"` — 5 separate Pi tools per server, or 1 unified tool with the operation name in params. Defaults to `"multi"`; shown explicitly above for clarity.
- `trust` — gatekeeper trust level for this server (`untrusted` / `user` / `developer` / `admin`). Defaults to `"user"`.

### Adapter spec forms

| Spec | Resolves to | Example |
|---|---|---|
| **Local path** (absolute, `./relative`, `../relative`, bare `.`, bare `..`, `~/home`, bare `~`) | `node <path>/dist/server.js` — convention is the entry lives at `dist/server.js` inside the directory | `/Users/me/adapters/github` |
| **npm package** (bare name, scoped, version-pinned) | `npx --yes <name>` — npx handles fetch + cache automatically | `@mcpaql/generated-github-mcp@1.2.3` |
| **git URL** (`git:host/owner/repo@ref` or `git+https://…`) | *Not yet implemented — tracked in issue #31* | `git:github.com/user/repo@v1` |

Specs containing `/` that aren't the npm scoped form (`@scope/name`) are rejected with explicit guidance — `adapters/my-server` is treated as ambiguous and prompts you to use either `./adapters/my-server` (local) or `@scope/name` (npm).

For local paths, the entry file at `<path>/dist/server.js` is checked for existence at startup, so a wrong path or missing build surfaces immediately with an actionable error rather than at first tool call. Permission-denied and missing-file cases produce distinct messages.

The `dist/server.js` entry-point is convention; per-adapter entry overrides (or `package.json#bin` lookup) are tracked as a follow-up.

> **Platform note.** Windows drive-letter paths (e.g. `C:\path\to\adapter`) are recognized as a local-path shape so Windows users get a sensible error message rather than silent dispatch to npx, but the supported runtime for this package is Node 20+ on Linux/macOS. Windows is not on the release matrix.

## Quick start with DollhouseMCP

[DollhouseMCP](https://github.com/DollhouseMCP/mcp-server) speaks MCP-AQL natively, so you can wire it up without writing or generating an adapter. This is the fastest way to see the bridge end-to-end against a real server.

1. **Copy the example config** to where the bridge looks for it:

   ```bash
   mkdir -p ~/.pi
   cp examples/mcpaql.config.example.json ~/.pi/mcpaql.config.json
   ```

   The example ships only the dollhouse entry, so it's runnable as-is. For reference, the file looks like:

   ```jsonc
   {
     "servers": [
       {
         "name": "dollhouse",
         "transport": "stdio",
         "command": "npx",
         "args": ["--yes", "@dollhousemcp/mcp-server"],
         "direct": true,
         "trust": "developer",
         "endpointMode": "multi"
       }
     ]
   }
   ```

   `trust: "developer"` reduces gatekeeper-confirmation friction for this demo. For day-to-day workflows that touch destructive operations (`delete_element`, `clear`, `clear_github_auth`), drop to `"user"` — the loader's default — so dollhouse's gatekeeper prompts before each destructive call.

2. **Smoke-test the wiring** without booting pi:

   ```bash
   npm run smoke:dollhouse
   ```

   This spawns `npx --yes @dollhousemcp/mcp-server@2.0.32`, calls `read/introspect`, and prints the operations list. First run pulls the package; subsequent runs hit the npx cache. Override the pin with `DOLLHOUSE_PKG=@dollhousemcp/mcp-server` to smoke against the latest published version.

3. **Launch pi** with the bridge as an extension. Once registered, the LLM sees `dollhouse_create` / `dollhouse_read` / `dollhouse_update` / `dollhouse_delete` / `dollhouse_execute` and can call `dollhouse_read introspect` to discover what dollhouse offers.

### Adapter-mode equivalent

Same upstream, slightly different config shape — uses #6's npm resolver instead of `direct`:

```jsonc
{
  "name": "dollhouse",
  "adapter": "@dollhousemcp/mcp-server",
  "trust": "developer",
  "endpointMode": "multi"
}
```

Both forms end up running `npx @dollhousemcp/mcp-server` as a stdio child. The `direct: true` form is canonical for natively-MCP-AQL servers; the `adapter:` form is the same npm-resolution path generated adapters use.

### Known conformance gaps

Live `read/introspect` against `@dollhousemcp/mcp-server` returns operations whose summary objects use `element_name` instead of the spec's `name` field. The bridge's discriminated-response envelope (`{ success, data }`) still validates, so call-and-response works end-to-end, but `OperationInfo`-shape strict validation flags this. The conformance test in `test/conformance-dollhouse.test.mjs` asserts both states (envelope passes, strict shape fails) and serves as a regression marker — when DollhouseMCP closes the gap, that test will need a fixture refresh.

## Installation

> Not yet published. Until then, see the issues for the walking-skeleton plan.

## Development

Tests run in three flavors. The Docker flavors keep your host clean of spawned MCP children, transient ports, and `dist/` churn.

```bash
npm test                  # bare metal — fast iteration, leaves dist/ on disk
npm run test:docker       # one-shot build + run in an isolated container
npm run test:docker:shell # interactive shell in the container, for debugging
npm run test:matrix       # run against Node 20, 22, 24 in parallel images
```

The `Dockerfile` accepts a `NODE_VERSION` build arg (default `20`) and is independent of CI — GitHub Actions still uses ubuntu-latest runners directly. If you ever want CI/local parity, point `ci.yml` at this image.

### Manual smokes (not in CI)

```bash
npm run smoke:dollhouse    # spawn dollhouse via spawnHost directly, call introspect
npm run smoke:entrypoint   # load examples/mcpaql.config.example.json and run the
                           # full loadConfig → spawnFromResolved → introspect chain
```

`smoke:dollhouse` exercises the host layer in isolation against a pinned dollhouse version. `smoke:entrypoint` exercises the entrypoint chain — config loading, projection, env interpolation, spawn, call — using the shipped example config. CI-gated equivalents (mock server, no network) live in `test/host.test.mjs` and `test/entrypoint.test.mjs`.

## Compatibility

The bridge is a host for spec-compliant MCP-AQL adapters. Any adapter generated by [`@mcpaql/adapter-generator`](https://github.com/MCPAQL/adapter-generator), or any server that speaks the [MCP-AQL spec](https://github.com/MCPAQL/spec) directly over MCP, should plug in without modification.

## Licensing

- **Code**: [AGPL-3.0](LICENSE)
- **Commercial licenses**: Available via licensing@mcpaql.org

## Related

- [MCP-AQL spec](https://github.com/MCPAQL/spec)
- [MCP-AQL reference adapter](https://github.com/MCPAQL/mcpaql-adapter)
- [MCP-AQL adapter generator](https://github.com/MCPAQL/adapter-generator)
- [Pi coding agent](https://pi.dev/) ([source](https://github.com/badlogic/pi-mono))
- [DollhouseMCP](https://github.com/DollhouseMCP/mcp-server) — reference MCP-AQL server
