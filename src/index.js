#!/usr/bin/env node
// mermaid-mcp — MCP server for Mermaid diagrams and collections.
//
//   node src/index.js            stateless Streamable HTTP (default)
//   node src/index.js --stdio    stdio, for local agents (Claude Code, opencode)

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError } from "./config.js";
import { createLogger } from "./logger.js";
import { createApiClient } from "./api.js";
import { createMcpServer } from "./tools.js";
import { startHttpServer } from "./http.js";

/** After this, a stuck connection is cut rather than blocking a deploy. */
const SHUTDOWN_GRACE_MS = 10_000;

function wantsStdio(argv, env) {
  return argv.includes("--stdio") || (env.TRANSPORT ?? "").trim().toLowerCase() === "stdio";
}

async function startStdio({ config, logger }) {
  if (!config.apiKey) {
    logger.warn("MERMAID_API_KEY is not set — tool calls will fail until it is (see README).");
  }
  const api = createApiClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.requestTimeoutMs,
  });
  const server = createMcpServer({ api, version: config.version, logger });
  await server.connect(new StdioServerTransport());
  logger.info("stdio ready", { backend: config.baseUrl, keyConfigured: Boolean(config.apiKey) });
  return { close: () => server.close() };
}

function installShutdown({ logger, close }) {
  let shuttingDown = false;

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("shutting down", { signal });

      const forceExit = setTimeout(() => {
        logger.warn("shutdown timed out, exiting anyway");
        process.exit(1);
      }, SHUTDOWN_GRACE_MS);
      forceExit.unref();

      Promise.resolve()
        .then(close)
        .then(() => process.exit(0))
        .catch((error) => {
          logger.error("shutdown failed", { error: error?.message ?? error });
          process.exit(1);
        });
    });
  }
}

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  for (const [event, handler] of [
    ["unhandledRejection", (reason) => reason],
    ["uncaughtException", (error) => error],
  ]) {
    process.on(event, (reason) => {
      const error = handler(reason);
      logger.error(`fatal: ${event}`, { error: error?.message ?? String(error), stack: error?.stack });
      process.exit(1);
    });
  }

  const handle = wantsStdio(process.argv.slice(2), process.env)
    ? await startStdio({ config, logger })
    : await startHttpServer({ config, logger });

  installShutdown({ logger, close: handle.close });
}

main().catch((error) => {
  // A bad env var is an operator mistake, not a crash: report it without a stack trace.
  if (error instanceof ConfigError) {
    createLogger().error("invalid configuration", { error: error.message });
  } else {
    createLogger().error("failed to start", { error: error?.message ?? String(error), stack: error?.stack });
  }
  process.exit(1);
});
