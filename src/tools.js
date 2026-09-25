// MCP tool definitions.
//
// One McpServer instance is created per connection (stdio) or per request
// (stateless HTTP), bound to the API client that carries that caller's key.
// Tool names and parameter shapes are part of the public contract — clients
// depend on them, so they only change with a major version bump.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SERVER_NAME = "mermaid";

const COLLECTION_ID_HINT = "Collection id to file it under";

/** Wrap a tool body with timing + failure logging. */
function observed(logger, name, handler) {
  return async (args) => {
    const startedAt = Date.now();
    try {
      const result = await handler(args);
      logger.info("tool call", { tool: name, ms: Date.now() - startedAt, ok: result?.isError !== true });
      return result;
    } catch (error) {
      logger.warn("tool call failed", { tool: name, ms: Date.now() - startedAt, error: error?.message ?? error });
      throw error;
    }
  };
}

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/** Drop keys the caller left unset so PATCH-style bodies stay minimal. */
function defined(...entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

/**
 * @param {object} options
 * @param {ReturnType<import("./api.js").createApiClient>} options.api
 * @param {string} options.version
 * @param {ReturnType<import("./logger.js").createLogger>} options.logger
 */
export function createMcpServer({ api, version, logger }) {
  const server = new McpServer({ name: SERVER_NAME, version });

  server.registerTool(
    "list_diagrams",
    {
      title: "List diagrams",
      description:
        "List Mermaid diagrams with their content. Supports a name search and pagination. " +
        "Responses include full diagram source, so use `search` and a small `limit` when you only need an overview.",
      inputSchema: {
        search: z.string().optional().describe("Substring filter on diagram name"),
        page: z.number().int().positive().default(1).describe("1-based page number"),
        limit: z.number().int().positive().max(100).default(20).describe("Diagrams per page (max 100)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    observed(logger, "list_diagrams", async ({ search, page, limit }) =>
      text(await api.get("/diagrams", { query: { page, limit, search } })),
    ),
  );

  server.registerTool(
    "get_diagram",
    {
      title: "Get diagram",
      description: "Get a single diagram by id, including its full Mermaid source and preview.",
      inputSchema: { id: z.string().describe("Diagram id") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    observed(logger, "get_diagram", async ({ id }) => text(await api.get(`/diagrams/${encodeURIComponent(id)}`))),
  );

  server.registerTool(
    "create_diagram",
    {
      title: "Create diagram",
      description: "Create a new Mermaid diagram. Omit `content` to get the backend's starter graph.",
      inputSchema: {
        name: z.string().min(1).max(255).describe("Diagram name"),
        content: z.string().optional().describe("Mermaid source, e.g. 'graph TD\\n    A-->B'"),
        collectionId: z.string().optional().describe(COLLECTION_ID_HINT),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    observed(logger, "create_diagram", async ({ name, content, collectionId }) =>
      text(await api.post("/diagrams", defined(["name", name], ["content", content], ["collectionId", collectionId]))),
    ),
  );

  server.registerTool(
    "update_diagram",
    {
      title: "Update diagram",
      description:
        "Update a diagram's name, Mermaid source and/or collection. Only the fields you pass are changed; " +
        "`content` replaces the whole source, so read the diagram first unless you are rewriting it entirely.",
      inputSchema: {
        id: z.string().describe("Diagram id"),
        name: z.string().min(1).max(255).optional().describe("New diagram name"),
        content: z.string().optional().describe("Full replacement mermaid source"),
        collectionId: z.string().nullable().optional().describe("Move to collection (null = unfiled)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    observed(logger, "update_diagram", async ({ id, ...patch }) =>
      text(await api.put(`/diagrams/${encodeURIComponent(id)}`, defined(...Object.entries(patch)))),
    ),
  );

  server.registerTool(
    "delete_diagram",
    {
      title: "Delete diagram",
      description: "Permanently delete a diagram by id. This cannot be undone.",
      inputSchema: { id: z.string().describe("Diagram id") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    observed(logger, "delete_diagram", async ({ id }) => {
      await api.delete(`/diagrams/${encodeURIComponent(id)}`);
      return text({ deleted: id });
    }),
  );

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description: "List collections (diagram folders) with their ids and names.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    observed(logger, "list_collections", async () => text(await api.get("/collections"))),
  );

  server.registerTool(
    "create_collection",
    {
      title: "Create collection",
      description: "Create a collection (diagram folder) to group diagrams.",
      inputSchema: { name: z.string().min(1).max(100).describe("Collection name") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    observed(logger, "create_collection", async ({ name }) => text(await api.post("/collections", { name }))),
  );

  server.registerTool(
    "delete_collection",
    {
      title: "Delete collection",
      description: "Delete a collection by id. Its diagrams are not deleted — they become unfiled.",
      inputSchema: { id: z.string().describe("Collection id") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    observed(logger, "delete_collection", async ({ id }) => {
      await api.delete(`/collections/${encodeURIComponent(id)}`);
      return text({ deleted: id });
    }),
  );

  return server;
}
