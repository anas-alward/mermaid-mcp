// Environment configuration.
//
// Everything is parsed and validated once, at boot, so a misconfigured
// deployment fails immediately with an actionable message instead of
// surfacing a confusing error on the first tool call.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Kept in sync with package.json automatically. */
export const VERSION = require("../package.json").version;

const DEFAULTS = {
  baseUrl: "https://mermaid.alward.dev",
  host: "0.0.0.0",
  port: 8120,
  mcpPath: "/mcp",
  requestTimeoutMs: 15_000,
  maxBodySize: "2mb",
  logLevel: "info",
  corsOrigins: "*",
};

const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function readInt(env, name, fallback, { min, max }) {
  const raw = (env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(raw)}).`);
  }
  return value;
}

function readBaseUrl(env, name, fallback) {
  const raw = (env[name] ?? "").trim() || fallback;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL, e.g. https://mermaid.example.com (got ${JSON.stringify(raw)}).`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must use http or https (got ${JSON.stringify(url.protocol)}).`);
  }
  return raw.replace(/\/+$/, "");
}

function readPath(env, name, fallback) {
  const raw = (env[name] ?? "").trim() || fallback;
  if (!raw.startsWith("/")) {
    throw new ConfigError(`${name} must start with "/" (got ${JSON.stringify(raw)}).`);
  }
  return raw.replace(/\/+$/, "") || "/";
}

function readList(env, name, fallback) {
  const raw = (env[name] ?? "").trim();
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readLogLevel(env) {
  const raw = (env.LOG_LEVEL ?? "").trim().toLowerCase() || DEFAULTS.logLevel;
  if (!LOG_LEVELS.includes(raw)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (got ${JSON.stringify(raw)}).`);
  }
  return raw;
}

/**
 * Build the immutable runtime config from an environment bag.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  return Object.freeze({
    version: VERSION,
    baseUrl: readBaseUrl(env, "MERMAID_BASE_URL", DEFAULTS.baseUrl),
    // Only used for --stdio. In HTTP mode the key must arrive per request.
    apiKey: (env.MERMAID_API_KEY ?? "").trim(),
    host: (env.HOST ?? "").trim() || DEFAULTS.host,
    port: readInt(env, "PORT", DEFAULTS.port, { min: 0, max: 65535 }),
    mcpPath: readPath(env, "MCP_PATH", DEFAULTS.mcpPath),
    requestTimeoutMs: readInt(env, "REQUEST_TIMEOUT_MS", DEFAULTS.requestTimeoutMs, { min: 100, max: 120_000 }),
    maxBodySize: (env.MAX_BODY_SIZE ?? "").trim() || DEFAULTS.maxBodySize,
    logLevel: readLogLevel(env),
    corsOrigins: readList(env, "CORS_ORIGINS", DEFAULTS.corsOrigins.split(",")),
    // Host allow-list for DNS-rebinding protection. null = disabled.
    allowedHosts: readList(env, "ALLOWED_HOSTS", null),
  });
}
