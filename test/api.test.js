import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApiClient, ApiError } from "../src/api.js";
import { sleep, startMockBackend } from "./helpers/mock-backend.js";

const KEY = "ek_test_key_do_not_log";

describe("api client", () => {
  let backend;
  let handler;
  let api;

  before(async () => {
    backend = await startMockBackend((call) => handler(call));
    api = createApiClient({ baseUrl: backend.baseUrl, apiKey: KEY });
  });

  after(() => backend.close());

  const useHandler = (fn) => {
    handler = fn;
  };

  it("sends the key as a bearer token and returns the parsed body", async () => {
    useHandler(() => ({ body: { diagrams: [], total: 0, page: 1, limit: 20 } }));

    const result = await api.get("/diagrams", { query: { page: 1, limit: 20, search: "flow" } });

    assert.deepEqual(result, { diagrams: [], total: 0, page: 1, limit: 20 });
    const [call] = backend.calls;
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.equal(call.url.pathname, "/api/v1/diagrams");
    assert.equal(call.url.searchParams.get("search"), "flow");
  });

  it("omits empty query values instead of sending blanks", async () => {
    useHandler(() => ({ body: { collections: [] } }));
    await api.get("/diagrams", { query: { page: 1, search: undefined, filter: "" } });

    const call = backend.calls.at(-1);
    assert.equal(call.url.search, "?page=1");
  });

  it("returns null for 204 No Content", async () => {
    useHandler(() => ({ status: 204 }));
    assert.equal(await api.delete("/diagrams/abc"), null);
  });

  it("json-encodes request bodies and sets content-type", async () => {
    useHandler(() => ({ body: { id: "new-id" } }));
    await api.post("/diagrams", { name: "Diagram", content: "graph TD\n  A-->B" });

    const call = backend.calls.at(-1);
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(call.body, { name: "Diagram", content: "graph TD\n  A-->B" });
  });

  it("keeps a hostile id from escaping its path segment", async () => {
    useHandler(() => ({ body: {} }));
    // The tool layer encodes ids; this is the property that buys us.
    await api.get(`/diagrams/${encodeURIComponent("weird?id#frag&x=1")}`);

    const call = backend.calls.at(-1);
    assert.equal(call.url.pathname, "/api/v1/diagrams/weird%3Fid%23frag%26x%3D1");
    assert.equal(call.url.search, "", "an id must never be able to add query parameters");
    assert.equal(call.url.hash, "", "an id must never be able to add a fragment");
  });

  it("maps 401 to an unauthorized ApiError without leaking the key", async () => {
    useHandler(() => ({ status: 401, body: { error: "Invalid API key" } }));

    const error = await api.get("/diagrams").then(
      () => null,
      (thrown) => thrown,
    );

    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "unauthorized");
    assert.equal(error.status, 401);
    assert.match(error.message, /Invalid API key/);
    assert.ok(!error.message.includes(KEY));
    assert.ok(!JSON.stringify(error.hint).includes(KEY));
  });

  it("maps 404 to not_found", async () => {
    useHandler(() => ({ status: 404, body: { error: "Diagram not found" } }));

    const error = await api.get("/diagrams/missing").catch((thrown) => thrown);
    assert.equal(error.code, "not_found");
    assert.match(error.message, /Diagram not found/);
  });

  it("flattens and truncates an HTML error body", async () => {
    useHandler(() => ({ status: 500, body: undefined, raw: "<html>\n  <body>oops</body>\n</html>" }));

    const error = await api.get("/diagrams").catch((thrown) => thrown);
    assert.equal(error.code, "upstream");
    assert.ok(!error.message.includes("\n"));
    assert.ok(error.message.length < 300);
  });

  it("gives up on a slow backend instead of hanging", async () => {
    useHandler(async () => {
      await sleep(400);
      return { body: {} };
    });
    const impatient = createApiClient({ baseUrl: backend.baseUrl, apiKey: KEY, timeoutMs: 60 });

    const error = await impatient.get("/diagrams").catch((thrown) => thrown);
    assert.equal(error.code, "timeout");
    assert.match(error.message, /timed out after 60ms/);
  });

  it("reports an unreachable backend as a network error", async () => {
    const offline = createApiClient({ baseUrl: "http://127.0.0.1:1", apiKey: KEY, timeoutMs: 2000 });

    const error = await offline.get("/diagrams").catch((thrown) => thrown);
    assert.equal(error.code, "network");
    assert.match(error.message, /could not reach/);
  });

  it("refuses to call out without a key, and says how to fix it", async () => {
    const keyless = createApiClient({ baseUrl: backend.baseUrl, apiKey: "" });
    useHandler(() => ({ body: { diagrams: [] } }));
    const callsBefore = backend.calls.length;

    const error = await keyless.get("/diagrams").catch((thrown) => thrown);
    assert.equal(error.code, "missing_api_key");
    assert.match(error.hint, /Bearer ek_/);
    assert.equal(backend.calls.length, callsBefore, "no request should have been made");
  });
});
