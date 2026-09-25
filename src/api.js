// Thin client for the Mermaid backend REST API (/api/v1).
//
// Responsibilities: build the request, attach the caller's API key, bound the
// wait with a timeout, and translate every failure mode into an ApiError whose
// message is safe (and useful) to hand back to a model.

const MAX_ERROR_DETAIL = 200;

/** Advice attached to auth failures, shown to the caller as a tool error. */
export const API_KEY_HINT =
  "Create a key in the Mermaid dashboard (avatar menu → API keys) and send it as " +
  "'Authorization: Bearer ek_...' (or 'x-mermaid-api-key: ek_...').";

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, hint?: string }} [options]
   */
  constructor(message, { status = 0, code = "upstream", hint } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/** Keep upstream error bodies short and single-line — they land in model context. */
function summarize(data, status) {
  const raw =
    (typeof data?.error === "string" && data.error) ||
    (typeof data?.message === "string" && data.message) ||
    (typeof data?.raw === "string" && data.raw) ||
    "";
  const detail = raw.replace(/\s+/g, " ").trim();
  return detail ? detail.slice(0, MAX_ERROR_DETAIL) : `HTTP ${status}`;
}

function toApiError(status, data, method, path) {
  const where = `Mermaid API ${method} ${path} → ${status}: ${summarize(data, status)}`;

  if (status === 401 || status === 403) {
    return new ApiError(`${where} — the API key was rejected.`, {
      status,
      code: "unauthorized",
      hint: "Check the key is current (ek_...) and belongs to the account you expect.",
    });
  }
  if (status === 404) {
    return new ApiError(where, { status, code: "not_found" });
  }
  if (status === 429) {
    return new ApiError(`${where} — rate limited, retry shortly.`, { status, code: "rate_limited" });
  }
  return new ApiError(where, { status, code: "upstream" });
}

function isAbort(error) {
  const name = error?.name ?? error?.cause?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function toTransportError(error, method, path, baseUrl, timeoutMs) {
  const where = `Mermaid API ${method} ${path}`;
  if (isAbort(error)) {
    return new ApiError(`${where} → timed out after ${timeoutMs}ms.`, {
      code: "timeout",
      hint: "The Mermaid backend did not answer in time. Retry, or raise REQUEST_TIMEOUT_MS.",
    });
  }
  return new ApiError(`${where} → could not reach ${baseUrl}: ${error?.cause?.message ?? error?.message ?? error}`, {
    code: "network",
    hint: "Check network connectivity and MERMAID_BASE_URL.",
  });
}

/**
 * @param {object} options
 * @param {string} options.baseUrl  Origin of the Mermaid deployment (no trailing slash).
 * @param {string} [options.apiKey] Dashboard API key (ek_...). Empty means "no credentials".
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl] Injectable for tests.
 */
export function createApiClient({ baseUrl, apiKey = "", timeoutMs = 15_000, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createApiClient requires a fetch implementation");
  }

  /**
   * @param {"GET"|"POST"|"PUT"|"DELETE"} method
   * @param {string} path Path below /api/v1, e.g. "/diagrams/abc".
   * @param {{ query?: Record<string, unknown>, body?: unknown }} [options]
   */
  async function request(method, path, { query, body } = {}) {
    if (!apiKey) {
      throw new ApiError("No Mermaid API key available for this request.", {
        code: "missing_api_key",
        hint: API_KEY_HINT,
      });
    }

    const url = new URL(`${baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw toTransportError(error, method, path, baseUrl, timeoutMs);
    }

    if (response.status === 204) return null;

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!response.ok) throw toApiError(response.status, data, method, path);
    return data;
  }

  return {
    request,
    get: (path, options) => request("GET", path, options),
    post: (path, body) => request("POST", path, { body }),
    put: (path, body) => request("PUT", path, { body }),
    delete: (path) => request("DELETE", path),
  };
}
