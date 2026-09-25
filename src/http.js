// Stateless Streamable HTTP transport.
//
// Every POST is self-contained: a fresh McpServer + transport pair is created,
// bound to the API key on that request, and torn down when the response ends.
// No session state, so the service scales horizontally behind any load balancer.

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { createApiClient, API_KEY_HINT } from "./api.js";
import { createMcpServer, SERVER_NAME } from "./tools.js";

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_INTERNAL_ERROR = -32603;

/** Bearer token (preferred) or the dedicated header. */
export function apiKeyFromRequest(req) {
  const authorization = req.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return bearer || (req.get("x-mermaid-api-key") ?? "").trim();
}

function rpcError(res, status, code, message, id = null) {
  res.status(status).type("application/json").json({ jsonrpc: "2.0", id, error: { code, message } });
}

function corsMiddleware(origins) {
  const allowAll = origins.includes("*");
  const allowList = new Set(origins);
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin && (allowAll || allowList.has(origin))) {
      res.set("access-control-allow-origin", allowAll ? "*" : origin);
      res.set("access-control-allow-headers", "authorization, content-type, mcp-session-id, mcp-protocol-version");
      res.set("access-control-expose-headers", "mcp-session-id");
    }
    if (req.method === "OPTIONS") {
      res.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      res.sendStatus(origin && (allowAll || allowList.has(origin)) ? 204 : 403);
      return;
    }
    next();
  };
}

/**
 * Build the Express app. Exported separately from listen() so tests can drive
 * it with an ephemeral port.
 *
 * @param {{ config: ReturnType<import("./config.js").loadConfig>, logger: ReturnType<import("./logger.js").createLogger> }} options
 */
export function createHttpApp({ config, logger }) {
  const app = express();
  const startedAt = Date.now();

  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(corsMiddleware(config.corsOrigins));
  if (config.allowedHosts) app.use(hostHeaderValidation(config.allowedHosts));

  // Content-Type: application/json is mandatory for JSON-RPC; the SDK's transport
  // also enforces the MCP-Protocol-Version header on non-initialize requests.
  app.use(express.json({ limit: config.maxBodySize }));

  app.get("/", (_req, res) =>
    res.json({ service: SERVER_NAME, version: config.version, mcp: config.mcpPath, health: "/healthz" }),
  );

  app.get("/healthz", (_req, res) =>
    res.json({
      status: "ok",
      service: SERVER_NAME,
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      backend: config.baseUrl,
    }),
  );

  app.post(config.mcpPath, async (req, res) => {
    const apiKey = apiKeyFromRequest(req);
    if (!apiKey) {
      // No WWW-Authenticate header on purpose: this is not an OAuth server, and
      // emitting one would push clients into an authorization-code flow.
      logger.warn("rejected unauthenticated request", { ip: req.ip });
      rpcError(res, 401, JSON_RPC_INVALID_REQUEST, `Missing Mermaid API key. ${API_KEY_HINT}`);
      return;
    }

    const api = createApiClient({ baseUrl: config.baseUrl, apiKey, timeoutMs: config.requestTimeoutMs });
    const server = createMcpServer({ api, version: config.version, logger });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

    // Both objects hold per-request resources; without this they leak.
    res.on("close", () => {
      void Promise.allSettled([server.close(), transport.close()]);
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("mcp request failed", { error: error?.message ?? error });
      if (!res.headersSent) {
        rpcError(res, 500, JSON_RPC_INTERNAL_ERROR, "Internal server error", req.body?.id ?? null);
      }
    }
  });

  const methodNotAllowed = (req, res) =>
    rpcError(
      res,
      405,
      JSON_RPC_INVALID_REQUEST,
      `This endpoint is stateless: use POST for MCP JSON-RPC on ${config.mcpPath}.`,
      req.body?.id ?? null,
    );

  app.get(config.mcpPath, methodNotAllowed);
  app.delete(config.mcpPath, methodNotAllowed);

  app.use((req, res) => {
    logger.warn("not found", { method: req.method, path: req.path });
    rpcError(res, 404, JSON_RPC_INVALID_REQUEST, `Not found: ${req.method} ${req.path}`);
  });

  // Express identifies error handlers by arity, so `next` must stay declared.
  app.use((error, req, res, _next) => {
    if (error?.type === "entity.too.large") {
      rpcError(res, 413, JSON_RPC_INVALID_REQUEST, `Request body exceeds the ${config.maxBodySize} limit.`);
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      rpcError(res, 400, JSON_RPC_PARSE_ERROR, "Request body is not valid JSON.");
      return;
    }
    logger.error("unhandled request error", { error: error?.message ?? error });
    rpcError(res, 500, JSON_RPC_INTERNAL_ERROR, "Internal server error", req.body?.id ?? null);
  });

  return app;
}

/**
 * Start listening. Returns the handle plus a close() that stops accepting new
 * connections and lets in-flight ones drain.
 */
export function startHttpServer({ config, logger }) {
  const app = createHttpApp({ config, logger });

  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host);
    const onStartupError = (error) => reject(error);
    server.once("error", onStartupError);
    server.once("listening", () => {
      // Past this point an 'error' event (EMFILE, ECONNRESET on accept) is not
      // a boot failure — and an unhandled one would take the process down.
      server.off("error", onStartupError);
      server.on("error", (error) => logger.error("http server error", { error: error?.message ?? error }));

      const address = server.address();
      logger.info("http ready", {
        url: `http://${config.host}:${address.port}${config.mcpPath}`,
        backend: config.baseUrl,
        cors: config.corsOrigins.join(","),
        allowedHosts: config.allowedHosts ? config.allowedHosts.join(",") : "any",
      });
      resolve({
        server,
        address,
        close: () =>
          new Promise((done) => {
            server.closeIdleConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
