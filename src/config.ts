/**
 * Config loader for ~/.pi/mcpaql.config.json.
 *
 * Reads the JSON file, validates against MCPAQL_CONFIG_SCHEMA via ajv,
 * applies defaults (trust="user", endpointMode="multi", transport="stdio"),
 * expands ${env:VAR} interpolations in env values, and returns a normalized
 * ResolvedServerConfig[].
 *
 * Soft-fails when the file is missing (returns empty servers with a notice).
 * Throws with actionable messages on hard failures (malformed JSON, schema
 * violation) so the entrypoint can surface them via ctx.ui.notify.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

export type TrustLevel = "untrusted" | "user" | "developer" | "admin";
export type EndpointMode = "multi" | "unified";

export interface ResolvedDirectConfig {
	kind: "direct";
	name: string;
	transport: "stdio";
	trust: TrustLevel;
	endpointMode: EndpointMode;
	command: string;
	args: string[];
	env: Record<string, string>;
}

export interface ResolvedAdapterConfig {
	kind: "adapter";
	name: string;
	transport: "stdio";
	trust: TrustLevel;
	endpointMode: EndpointMode;
	adapter: string;
	env: Record<string, string>;
}

export type ResolvedServerConfig = ResolvedDirectConfig | ResolvedAdapterConfig;

export interface LoadResult {
	/** Absolute path that was read (or attempted). */
	configPath: string;
	/** Whether the file existed and was loaded. */
	loaded: boolean;
	/** Validated, defaulted, interpolated server configs. */
	servers: ResolvedServerConfig[];
	/** Soft notices (file missing, env var unset). Surface to the user. */
	notices: string[];
}

export class ConfigError extends Error {
	constructor(
		message: string,
		readonly configPath: string,
	) {
		super(message);
		this.name = "ConfigError";
	}
}

export const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "mcpaql.config.json");

export const MCPAQL_CONFIG_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://mcpaql.org/schemas/mcpaql-config.schema.json",
	title: "MCP-AQL pi-bridge config",
	type: "object",
	additionalProperties: false,
	required: ["servers"],
	properties: {
		servers: {
			type: "array",
			items: {
				oneOf: [
					{
						type: "object",
						title: "Direct server (talks MCP-AQL natively)",
						additionalProperties: false,
						required: ["name", "direct", "command"],
						properties: {
							name: SERVER_NAME(),
							transport: TRANSPORT(),
							direct: { const: true },
							command: { type: "string", minLength: 1 },
							args: { type: "array", items: { type: "string" } },
							env: ENV_MAP(),
							trust: TRUST(),
							endpointMode: ENDPOINT_MODE(),
						},
					},
					{
						type: "object",
						title: "Adapter server (wrapped via @mcpaql/adapter-generator output)",
						additionalProperties: false,
						required: ["name", "adapter"],
						properties: {
							name: SERVER_NAME(),
							transport: TRANSPORT(),
							adapter: { type: "string", minLength: 1 },
							env: ENV_MAP(),
							trust: TRUST(),
							endpointMode: ENDPOINT_MODE(),
						},
					},
				],
			},
		},
	},
} as const;

function SERVER_NAME() {
	return {
		type: "string",
		pattern: "^[a-z][a-z0-9_]*$",
		description:
			"Identifier used for tool naming (snake_case, must start with a lowercase letter).",
	} as const;
}

function TRANSPORT() {
	return {
		type: "string",
		enum: ["stdio"],
		default: "stdio",
	} as const;
}

function ENV_MAP() {
	return {
		type: "object",
		additionalProperties: { type: "string" },
		description:
			"Environment variables passed to the spawned server. Values may include ${env:VAR} substitutions.",
	} as const;
}

function TRUST() {
	return {
		type: "string",
		enum: ["untrusted", "user", "developer", "admin"],
		default: "user",
	} as const;
}

function ENDPOINT_MODE() {
	return {
		type: "string",
		enum: ["multi", "unified"],
		default: "multi",
	} as const;
}

const ajv = new Ajv2020.default({
	strict: false,
	allErrors: true,
	useDefaults: true,
});

const validateConfig = ajv.compile(MCPAQL_CONFIG_SCHEMA);

export async function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Promise<LoadResult> {
	const result: LoadResult = {
		configPath,
		loaded: false,
		servers: [],
		notices: [],
	};

	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			result.notices.push(`No config file at ${configPath} (skipping; create one to wire servers).`);
			return result;
		}
		throw new ConfigError(
			`Failed to read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
			configPath,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ConfigError(
			`Malformed JSON in ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
			configPath,
		);
	}

	if (!validateConfig(parsed)) {
		const errs = (validateConfig.errors ?? [])
			.map((e) => `  ${e.instancePath || "(root)"} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ""}`)
			.join("\n");
		throw new ConfigError(
			`Schema validation failed for ${configPath}:\n${errs}`,
			configPath,
		);
	}

	const config = parsed as { servers: Array<Record<string, unknown>> };

	// Reject duplicate names early — the LLM-side tool registry uses these as
	// prefixes, and collisions would silently overwrite tools.
	const seen = new Set<string>();
	for (const s of config.servers) {
		const name = String(s.name);
		if (seen.has(name)) {
			throw new ConfigError(
				`Duplicate server name "${name}" in ${configPath}; each server must have a unique name.`,
				configPath,
			);
		}
		seen.add(name);
	}

	for (const raw of config.servers) {
		result.servers.push(normalizeServer(raw, result.notices));
	}

	result.loaded = true;
	return result;
}

function normalizeServer(
	raw: Record<string, unknown>,
	notices: string[],
): ResolvedServerConfig {
	const name = String(raw.name);
	const transport = (raw.transport as "stdio" | undefined) ?? "stdio";
	const trust = (raw.trust as TrustLevel | undefined) ?? "user";
	const endpointMode = (raw.endpointMode as EndpointMode | undefined) ?? "multi";
	const env = expandEnvMap((raw.env as Record<string, string> | undefined) ?? {}, name, notices);

	if (raw.direct === true) {
		return {
			kind: "direct",
			name,
			transport,
			trust,
			endpointMode,
			command: String(raw.command),
			args: Array.isArray(raw.args) ? (raw.args as string[]) : [],
			env,
		};
	}

	return {
		kind: "adapter",
		name,
		transport,
		trust,
		endpointMode,
		adapter: String(raw.adapter),
		env,
	};
}

const ENV_INTERP_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandEnvMap(
	source: Record<string, string>,
	serverName: string,
	notices: string[],
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		out[key] = value.replace(ENV_INTERP_RE, (_match, varName: string) => {
			const resolved = process.env[varName];
			if (resolved === undefined) {
				notices.push(
					`Server "${serverName}": env var $${varName} is unset; ${key} will be empty.`,
				);
				return "";
			}
			return resolved;
		});
	}
	return out;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}
