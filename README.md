# mermaid-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent full access to your
[Mermaid](https://mermaid.alward.dev) diagrams and collections — list, read, create, update and
delete over the Mermaid REST API.

- **Two transports.** `stdio` for local agents (Claude Code, opencode), stateless
  Streamable HTTP for remote clients and shared deployments.
- **No database, no session state.** It is a thin, well-behaved proxy in front of the Mermaid API:
  whatever the backend can do, the agent can do.
- **Per-caller credentials.** Each HTTP request carries its own Mermaid API key, so one deployment
  can serve many users without leaking anyone's diagrams.

---

## Tools

| Tool | What it does |
| --- | --- |
| `list_diagrams` | List diagrams. Optional `search` (name substring), `page`, `limit` (max 100). |
| `get_diagram` | Fetch one diagram by id, including its full Mermaid source. |
| `create_diagram` | Create a diagram from a name and Mermaid source, optionally in a collection. |
| `update_diagram` | Change a diagram's `name`, `content` and/or `collectionId` (`null` = unfiled). |
| `delete_diagram` | Permanently delete a diagram. |
| `list_collections` | List collections (diagram folders). |
| `create_collection` | Create a collection. |
| `delete_collection` | Delete a collection. Its diagrams survive and become unfiled. |

> `list_diagrams` returns the **full source** of every diagram in the page, so responses get large
> fast. Give the agent a `search` term or a small `limit` when it only needs an overview.

---

## Quick start

### Local agent (stdio)

Create an API key in the Mermaid dashboard (avatar menu → **API keys**), then point your client at
this server:

```bash
npm install
MERMAID_API_KEY=ek_... npm run start:stdio
```

**Claude Code**

```bash
claude mcp add mermaid --env MERMAID_API_KEY=ek_... -- node /path/to/mermaid-mcp/src/index.js --stdio
```

**opencode** — add to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mermaid": {
      "type": "local",
      "command": ["node", "/path/to/mermaid-mcp/src/index.js", "--stdio"],
      "environment": { "MERMAID_API_KEY": "ek_..." },
      "enabled": true
    }
  }
}
```

### Remote client (HTTP)

```bash
MERMAID_BASE_URL=https://mermaid.alward.dev PORT=8120 node src/index.js
```

The endpoint is `POST http://<host>:8120/mcp`, stateless. Send the caller's key on every request:

```bash
curl -X POST http://localhost:8120/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $MERMAID_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`accept` must include **both** `application/json` and `text/event-stream`, as the MCP Streamable
HTTP spec requires.

**opencode / other remote MCP clients:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mermaid": {
      "type": "remote",
      "url": "https://mermaid.example.com/mcp",
      "enabled": true,
      "headers": { "authorization": "Bearer ek_..." }
    }
  }
}
```

### Docker

```bash
docker build -t mermaid-mcp .
docker run -d -p 8120:8120 -e MERMAID_BASE_URL=https://mermaid.alward.dev mermaid-mcp
```

The image runs as the unprivileged `node` user and ships a `HEALTHCHECK` against `/healthz`, so
`docker run` reports `healthy` on its own.

### Deploying to a server

The repo is the source of truth. Clone it on the host and build from the checkout:

```bash
git clone https://github.com/anas-alward/mermaid-mcp.git mcp-server
cd mcp-server && npm ci          # only needed to run the suite on the host
```

To deploy an update:

```bash
cd mcp-server && git pull
cd .. && docker compose build mcp && docker compose up -d mcp
docker compose ps                 # wait for (healthy)
curl -s localhost:8120/healthz   # version confirms which build is live
```

Two things to know when the server directory is a git checkout:

- `.env` is gitignored, so it never travels with the clone. Create it on the host; the compose file
  declares it `required: false`, and the server only reads it for `--stdio`.
- `.dockerignore` excludes `.git`, so clone history stays out of the build context and the image.

Without git on the host, rsync the tree instead — the deploy directory only needs to match the
repository, plus `.env`.

---

## Authentication

The server holds no credentials of its own. In **HTTP mode the key must arrive on the request**,
as either header:

```
authorization: Bearer ek_...
x-mermaid-api-key: ek_...
```

A request without one gets `401` and a JSON-RPC error explaining how to fix it. `MERMAID_API_KEY`
is only consulted in `--stdio` mode, where there are no HTTP headers to read it from.

> **Changed in 1.0.0.** 0.2.0 silently fell back to the server's `MERMAID_API_KEY` when a request
> carried no key — which meant a publicly reachable deployment would hand one account's diagrams to
> anonymous callers. HTTP mode is now strict.

### Upgrading from 0.2.x

- Entry point moved: `node server.mjs` → `node src/index.js` (add `--stdio` for stdio mode).
  Container `CMD` and client configs need the new path.
- HTTP requests must carry their own key; `MERMAID_API_KEY` is now stdio-only.
- `MERMAID_HOST_HEADER` is gone. It never worked — `fetch` will not let you override `Host` — so if
  you were reaching a backend directly, point `MERMAID_BASE_URL` at the address that routes to it.
- Tool names, parameters and responses are unchanged.

---

## Configuration

All configuration is environment variables, validated at boot: a bad value stops the process with a
message naming the variable, rather than failing later on the first tool call.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERMAID_BASE_URL` | `https://mermaid.alward.dev` | Origin of the Mermaid deployment. No trailing slash, no `/api/v1`. |
| `MERMAID_API_KEY` | — | Dashboard API key. **stdio mode only**; ignored in HTTP mode. |
| `HOST` | `0.0.0.0` | HTTP bind address. Use `127.0.0.1` to keep it local. |
| `PORT` | `8120` | HTTP port. `0` picks a free port (used by tests). |
| `MCP_PATH` | `/mcp` | Path the MCP endpoint is served from. |
| `REQUEST_TIMEOUT_MS` | `15000` | Abort an upstream call that takes longer. |
| `MAX_BODY_SIZE` | `2mb` | Largest accepted MCP request body. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |
| `CORS_ORIGINS` | `*` | Comma-separated browser origins, or `*`. |
| `ALLOWED_HOSTS` | — | Comma-separated `Host` allow-list. Unset disables the check. |

Copy `.env.example` as a starting point. The process does not read `.env` files itself — use your
process manager, `docker run -e`, or `--env-file`.

---

## HTTP endpoints

| Route | Purpose |
| --- | --- |
| `POST /mcp` | MCP JSON-RPC. Stateless; no session id is issued. |
| `GET /healthz` | Liveness/readiness for load balancers and the Docker healthcheck. |
| `GET /` | Service name, version and where things live. |
| `GET`/`DELETE /mcp` | `405` with a JSON-RPC error — this endpoint is POST-only. |

Errors are always JSON-RPC shaped: `-32700` for a malformed body, `-32600` for a bad request or
missing key, `-32603` for an internal fault. Upstream failures (bad key, missing diagram, timeout)
come back as **tool results with `isError: true`**, so the agent can read what went wrong and retry
instead of seeing a transport crash.

**Security knobs.** Auth is a bearer token, not a cookie, so there is no CSRF surface; `CORS_ORIGINS`
only matters for browser clients. Set `ALLOWED_HOSTS` when the server is reachable from a browser to
close off DNS-rebinding. Terminate TLS in front of it — the server speaks plain HTTP.

**Operations.** Logs go to stderr, one line per event, with credential-shaped fields redacted. Set
`LOG_LEVEL=debug` to also see rejected requests. `SIGINT`/`SIGTERM` drain in-flight requests and
exit 0, with a 10s backstop.

---

## Development

```bash
npm install
npm test          # node:test — no network, no API key needed
npm run dev       # HTTP mode with --watch
```

The suite runs against an in-process mock of the Mermaid API, so it is fast and hermetic. It covers
the API client (auth, error mapping, timeouts, id encoding), all eight tools through a real MCP
client, and the HTTP layer (auth, CORS, host validation, body limits, JSON-RPC error shapes).

### Layout

```
src/
  index.js    entry point: transport selection, shutdown, fatal error handling
  config.js   environment parsing and validation
  logger.js   levelled stderr logging with redaction
  api.js      Mermaid REST client: auth, timeout, error translation
  tools.js    the eight MCP tools
  http.js     Express app, stateless Streamable HTTP, health, CORS, host checks
test/         node:test suites + mock backend
```

Adding a tool means adding one `server.registerTool(...)` block in `src/tools.js` and a test in
`test/tools.test.js`. Nothing else needs to know about it.

---

## Before you publish

`git init`, then push — CI runs the suite on Node 20 and 22.

## License

MIT © 2026 Anas Alward. See [LICENSE](LICENSE).
