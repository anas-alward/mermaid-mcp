import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http.js";
import { silentLogger, startMockBackend } from "./helpers/mock-backend.js";

const KEY = "ek_http_test_key";
const JSONRPC_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("http transport", () => {
  let backend;
  let handler;
  let handle;
  let base;

  before(async () => {
    backend = await startMockBackend((call) => handler(call));
    handle = await startHttpServer({
      config: loadConfig({
        PORT: "0",
        HOST: "127.0.0.1",
        MERMAID_BASE_URL: backend.baseUrl,
        LOG_LEVEL: "silent",
      }),
      logger: silentLogger,
    });
    base = `http://127.0.0.1:${handle.address.port}`;
  });

  after(async () => {
    await handle.close();
    await backend.close();
  });

  const useHandler = (fn) => {
    handler = fn;
  };

  const rpc = (body, { key = KEY, headers = {}, path = "/mcp", method = "POST" } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...JSONRPC_HEADERS, ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    });

  it("reports health without requiring a key", async () => {
    const res = await fetch(`${base}/healthz`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.service, "mermaid");
    assert.equal(typeof body.version, "string");
    assert.equal(body.backend, backend.baseUrl);
  });

  it("describes itself at the root", async () => {
    const body = await (await fetch(`${base}/`)).json();
    assert.equal(body.mcp, "/mcp");
    assert.equal(body.health, "/healthz");
  });

  it("rejects a request with no API key", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { key: null });
    const body = await res.json();

    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), null, "must not trigger an OAuth flow");
    assert.equal(body.error.code, -32600);
    assert.match(body.error.message, /Bearer ek_/);
  });

  it("rejects a request with an empty bearer token", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { key: "" });
    assert.equal(res.status, 401);
  });

  it("initialises without a session id", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.result.serverInfo.name, "mermaid");
    assert.equal(res.headers.get("mcp-session-id"), null);
  });

  it("lists the eight tools over HTTP", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.result.tools.length, 8);
    assert.ok(body.result.tools.some((tool) => tool.name === "list_diagrams"));
  });

  it("reaches the backend with the caller's key", async () => {
    useHandler(() => ({ body: { diagrams: [{ id: "1", name: "Remote" }], total: 1 } }));

    const res = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_diagrams", arguments: { page: 1, limit: 1 } },
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.match(body.result.content[0].text, /Remote/);
    assert.equal(backend.calls.at(-1).headers.authorization, `Bearer ${KEY}`);
  });

  it("keeps keys isolated between requests", async () => {
    useHandler(() => ({ body: { diagrams: [] } }));

    await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_diagrams", arguments: {} } }, { key: "ek_user_a" });
    await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_diagrams", arguments: {} } }, { key: "ek_user_b" });

    const keys = backend.calls.slice(-2).map((call) => call.headers.authorization);
    assert.deepEqual(keys, ["Bearer ek_user_a", "Bearer ek_user_b"]);
  });

  it("turns an upstream failure into a tool error, keeping HTTP 200", async () => {
    useHandler(() => ({ status: 404, body: { error: "Diagram not found" } }));

    const res = await rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "get_diagram", arguments: { id: "missing" } },
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /Diagram not found/);
  });

  it("answers GET on the MCP path with a JSON-RPC 405", async () => {
    const res = await rpc(null, { method: "GET" });
    const body = await res.json();

    assert.equal(res.status, 405);
    assert.equal(body.error.code, -32600);
    assert.match(body.error.message, /stateless/);
  });

  it("answers DELETE on the MCP path with a JSON-RPC 405", async () => {
    const res = await rpc(null, { method: "DELETE" });
    assert.equal(res.status, 405);
  });

  it("returns a JSON-RPC parse error for a malformed body", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...JSONRPC_HEADERS, authorization: `Bearer ${KEY}` },
      body: "{not json",
    });
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.equal(body.error.code, -32700);
  });

  it("rejects an oversized body", async () => {
    const res = await rpc(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "create_diagram", arguments: { name: "big", content: "x".repeat(3 * 1024 * 1024) } } },
    );
    const body = await res.json();

    assert.equal(res.status, 413);
    assert.match(body.error.message, /exceeds/);
  });

  it("answers unknown routes with a JSON-RPC 404", async () => {
    const res = await fetch(`${base}/nope`);
    const body = await res.json();

    assert.equal(res.status, 404);
    assert.equal(body.jsonrpc, "2.0");
    assert.match(body.error.message, /Not found/);
  });

  it("answers a CORS preflight", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://app.example.com", "access-control-request-method": "POST" },
    });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });

  it("does not treat other paths as the MCP endpoint", async () => {
    const res = await fetch(`${base}/nope`, { method: "POST", headers: JSONRPC_HEADERS });
    assert.equal(res.status, 404);
  });
});

describe("http hardening", () => {
  it("serves MCP from a custom path", async () => {
    const backend = await startMockBackend(() => ({ body: { tools: [] } }));
    const handle = await startHttpServer({
      config: loadConfig({
        PORT: "0",
        HOST: "127.0.0.1",
        MERMAID_BASE_URL: backend.baseUrl,
        MCP_PATH: "/rpc",
        LOG_LEVEL: "silent",
      }),
      logger: silentLogger,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${handle.address.port}/rpc`, {
        method: "POST",
        headers: { ...JSONRPC_HEADERS, authorization: "Bearer ek_x" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(res.status, 200);

      // /healthz is a fixed operational route, not a configurable one.
      const health = await fetch(`http://127.0.0.1:${handle.address.port}/healthz`);
      assert.equal(health.status, 200);
    } finally {
      await handle.close();
      await backend.close();
    }
  });

  it("rejects a Host header outside the allow-list", async () => {
    const backend = await startMockBackend(() => ({ body: {} }));
    const handle = await startHttpServer({
      config: loadConfig({
        PORT: "0",
        HOST: "127.0.0.1",
        MERMAID_BASE_URL: backend.baseUrl,
        ALLOWED_HOSTS: "mermaid.example.com",
        LOG_LEVEL: "silent",
      }),
      logger: silentLogger,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${handle.address.port}/mcp`, {
        method: "POST",
        headers: { ...JSONRPC_HEADERS, authorization: "Bearer ek_x" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

      assert.equal(res.status, 403);
      assert.equal(backend.calls.length, 0);
    } finally {
      await handle.close();
      await backend.close();
    }
  });

  it("scopes CORS to the configured origins", async () => {
    const backend = await startMockBackend(() => ({ body: {} }));
    const handle = await startHttpServer({
      config: loadConfig({
        PORT: "0",
        HOST: "127.0.0.1",
        MERMAID_BASE_URL: backend.baseUrl,
        CORS_ORIGINS: "https://app.example.com",
        LOG_LEVEL: "silent",
      }),
      logger: silentLogger,
    });

    try {
      const allowed = await fetch(`http://127.0.0.1:${handle.address.port}/healthz`, {
        headers: { origin: "https://app.example.com" },
      });
      assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example.com");

      const denied = await fetch(`http://127.0.0.1:${handle.address.port}/healthz`, {
        headers: { origin: "https://evil.example.com" },
      });
      assert.equal(denied.headers.get("access-control-allow-origin"), null);
    } finally {
      await handle.close();
      await backend.close();
    }
  });
});
