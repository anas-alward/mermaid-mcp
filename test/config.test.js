import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, ConfigError, VERSION } from "../src/config.js";

describe("config", () => {
  it("has working defaults for an empty environment", () => {
    const config = loadConfig({});

    assert.equal(config.baseUrl, "https://mermaid.alward.dev");
    assert.equal(config.port, 8120);
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.mcpPath, "/mcp");
    assert.equal(config.requestTimeoutMs, 15_000);
    assert.equal(config.maxBodySize, "2mb");
    assert.equal(config.logLevel, "info");
    assert.deepEqual(config.corsOrigins, ["*"]);
    assert.equal(config.allowedHosts, null);
    assert.equal(config.apiKey, "");
    assert.equal(config.version, VERSION);
  });

  it("trims trailing slashes and whitespace", () => {
    const config = loadConfig({ MERMAID_BASE_URL: "https://mermaid.example.com///", MCP_PATH: "/rpc///" });
    assert.equal(config.baseUrl, "https://mermaid.example.com");
    assert.equal(config.mcpPath, "/rpc");
  });

  it("parses lists", () => {
    const config = loadConfig({ CORS_ORIGINS: "https://a.example.com, https://b.example.com", ALLOWED_HOSTS: "a.example.com" });
    assert.deepEqual(config.corsOrigins, ["https://a.example.com", "https://b.example.com"]);
    assert.deepEqual(config.allowedHosts, ["a.example.com"]);
  });

  it("accepts port 0 for ephemeral binding", () => {
    assert.equal(loadConfig({ PORT: "0" }).port, 0);
  });

  for (const [env, pattern] of [
    [{ PORT: "http" }, /PORT must be an integer/],
    [{ PORT: "70000" }, /PORT must be an integer/],
    [{ PORT: "-1" }, /PORT must be an integer/],
    [{ LOG_LEVEL: "chatty" }, /LOG_LEVEL must be one of/],
    [{ MERMAID_BASE_URL: "not-a-url" }, /MERMAID_BASE_URL must be an absolute URL/],
    [{ MERMAID_BASE_URL: "ftp://mermaid.example.com" }, /must use http or https/],
    [{ MCP_PATH: "mcp" }, /MCP_PATH must start with/],
    [{ REQUEST_TIMEOUT_MS: "10" }, /REQUEST_TIMEOUT_MS must be an integer/],
  ]) {
    it(`rejects ${JSON.stringify(env)}`, () => {
      assert.throws(() => loadConfig(env), (error) => error instanceof ConfigError && pattern.test(error.message));
    });
  }
});
