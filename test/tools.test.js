import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApiClient } from "../src/api.js";
import { createMcpServer } from "../src/tools.js";
import { VERSION } from "../src/config.js";
import { silentLogger, startMockBackend } from "./helpers/mock-backend.js";

const KEY = "ek_tools_test_key";

/** Wire a real MCP client to a real McpServer over an in-memory transport. */
async function connect({ apiKey = KEY, baseUrl }) {
  const api = createApiClient({ baseUrl, apiKey });
  const server = createMcpServer({ api, version: VERSION, logger: silentLogger });
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    close: () => Promise.all([client.close(), server.close()]),
  };
}

const textOf = (result) => result.content.map((part) => part.text).join("\n");

describe("mcp tools", () => {
  let backend;
  let handler;
  let session;

  before(async () => {
    backend = await startMockBackend((call) => handler(call));
    session = await connect({ baseUrl: backend.baseUrl });
  });

  after(async () => {
    await session.close();
    await backend.close();
  });

  const useHandler = (fn) => {
    handler = fn;
  };

  it("exposes the eight documented tools", async () => {
    const { tools } = await session.client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        "create_collection",
        "create_diagram",
        "delete_collection",
        "delete_diagram",
        "get_diagram",
        "list_collections",
        "list_diagrams",
        "update_diagram",
      ],
    );
  });

  it("marks destructive tools as destructive", async () => {
    const { tools } = await session.client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.delete_diagram.annotations.destructiveHint, true);
    assert.equal(byName.delete_collection.annotations.destructiveHint, true);
    assert.equal(byName.list_diagrams.annotations.readOnlyHint, true);
    assert.equal(byName.get_diagram.annotations.readOnlyHint, true);
    assert.equal(byName.update_diagram.annotations.destructiveHint, false);
  });

  it("advertises its name and version", async () => {
    assert.deepEqual(session.client.getServerVersion(), { name: "mermaid", version: VERSION });
  });

  it("list_diagrams forwards pagination and search", async () => {
    useHandler(() => ({ body: { diagrams: [{ id: "1", name: "Flow" }], total: 1, page: 2, limit: 5 } }));

    const result = await session.call("list_diagrams", { page: 2, limit: 5, search: "Flow" });

    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(textOf(result)).diagrams[0].name, "Flow");
    const call = backend.calls.at(-1);
    assert.equal(call.url.pathname, "/api/v1/diagrams");
    assert.equal(call.url.searchParams.get("page"), "2");
    assert.equal(call.url.searchParams.get("limit"), "5");
    assert.equal(call.url.searchParams.get("search"), "Flow");
  });

  it("applies the documented defaults for list_diagrams", async () => {
    useHandler(() => ({ body: { diagrams: [] } }));
    await session.call("list_diagrams");

    const call = backend.calls.at(-1);
    assert.equal(call.url.searchParams.get("page"), "1");
    assert.equal(call.url.searchParams.get("limit"), "20");
    assert.equal(call.url.searchParams.has("search"), false);
  });

  it("get_diagram reads one diagram", async () => {
    useHandler(() => ({ body: { id: "abc", name: "One", content: "graph TD\n A-->B" } }));

    const result = await session.call("get_diagram", { id: "abc" });

    assert.equal(JSON.parse(textOf(result)).content, "graph TD\n A-->B");
    assert.equal(backend.calls.at(-1).url.pathname, "/api/v1/diagrams/abc");
  });

  it("create_diagram sends only the fields the caller provided", async () => {
    useHandler(() => ({ body: { id: "new", name: "Bare" } }));
    await session.call("create_diagram", { name: "Bare" });

    assert.deepEqual(backend.calls.at(-1).body, { name: "Bare" });
  });

  it("create_diagram forwards content and collectionId", async () => {
    useHandler(() => ({ body: { id: "new" } }));
    await session.call("create_diagram", { name: "Full", content: "graph LR\n A-->B", collectionId: "c1" });

    assert.deepEqual(backend.calls.at(-1).body, { name: "Full", content: "graph LR\n A-->B", collectionId: "c1" });
  });

  it("update_diagram patches only what changed and can unfile a diagram", async () => {
    useHandler(() => ({ body: { id: "abc" } }));
    await session.call("update_diagram", { id: "abc", name: "Renamed" });
    assert.deepEqual(backend.calls.at(-1).body, { name: "Renamed" });

    await session.call("update_diagram", { id: "abc", collectionId: null });
    assert.deepEqual(backend.calls.at(-1).body, { collectionId: null });
    assert.equal(backend.calls.at(-1).method, "PUT");
  });

  it("delete_diagram confirms the deletion", async () => {
    useHandler(() => ({ status: 204 }));
    const result = await session.call("delete_diagram", { id: "abc" });

    assert.deepEqual(JSON.parse(textOf(result)), { deleted: "abc" });
    assert.equal(backend.calls.at(-1).method, "DELETE");
  });

  it("delete_collection confirms the deletion", async () => {
    useHandler(() => ({ status: 204 }));
    const result = await session.call("delete_collection", { id: "c1" });

    assert.deepEqual(JSON.parse(textOf(result)), { deleted: "c1" });
    assert.equal(backend.calls.at(-1).url.pathname, "/api/v1/collections/c1");
  });

  it("list_collections returns collections", async () => {
    useHandler(() => ({ body: { collections: [{ id: "c1", name: "Work" }] } }));
    const result = await session.call("list_collections");

    assert.equal(JSON.parse(textOf(result)).collections[0].name, "Work");
  });

  it("surfaces an upstream 404 as a tool error, not a crash", async () => {
    useHandler(() => ({ status: 404, body: { error: "Diagram not found" } }));
    const result = await session.call("get_diagram", { id: "missing" });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Diagram not found/);
  });

  it("surfaces a rejected key as a tool error", async () => {
    useHandler(() => ({ status: 401, body: { error: "Invalid API key" } }));
    const result = await session.call("list_diagrams", { page: 1, limit: 1 });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Invalid API key/);
  });

  it("rejects invalid arguments before calling the backend", async () => {
    useHandler(() => ({ body: {} }));
    const before = backend.calls.length;

    const result = await session.call("list_diagrams", { page: 0 });

    assert.equal(result.isError, true);
    assert.equal(backend.calls.length, before);
  });

  it("keeps each caller's key on its own requests", async () => {
    useHandler(() => ({ body: { diagrams: [] } }));
    const other = await connect({ baseUrl: backend.baseUrl, apiKey: "ek_second_key" });

    try {
      await session.call("list_diagrams", { page: 1, limit: 1 });
      await other.call("list_diagrams", { page: 1, limit: 1 });

      const keys = backend.calls.slice(-2).map((call) => call.headers.authorization);
      assert.deepEqual(keys, [`Bearer ${KEY}`, "Bearer ek_second_key"]);
    } finally {
      await other.close();
    }
  });

  it("reports missing credentials instead of calling out", async () => {
    useHandler(() => ({ body: { diagrams: [] } }));
    const keyless = await connect({ baseUrl: backend.baseUrl, apiKey: "" });

    try {
      const result = await keyless.call("list_diagrams", { page: 1, limit: 1 });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /No Mermaid API key/);
    } finally {
      await keyless.close();
    }
  });
});
