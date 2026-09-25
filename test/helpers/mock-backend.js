// A tiny stand-in for the Mermaid backend, so the suite never touches the
// network or needs a real API key.

import { createServer } from "node:http";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {(call: {method: string, url: URL, headers: object, body: unknown}) => any} handler
 *   Return `{ status?, body? }`; omit `body` for 204, or `raw` for a non-JSON body.
 */
export async function startMockBackend(handler) {
  /** @type {Array<{method: string, url: URL, headers: object, body: unknown}>} */
  const calls = [];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");

    const call = {
      method: req.method,
      url: new URL(req.url, "http://mock"),
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    calls.push(call);

    const result = (await handler(call)) ?? {};
    const status = result.status ?? 200;
    if (result.raw !== undefined) {
      res.writeHead(status, { "content-type": "text/html" });
      res.end(result.raw);
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(result.body === undefined ? "" : JSON.stringify(result.body));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A logger that keeps output out of the test report. */
export const silentLogger = {
  level: "silent",
  debug() {},
  info() {},
  warn() {},
  error() {},
};
