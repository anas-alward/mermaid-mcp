// Minimal levelled logger.
//
// Writes to stderr only. That matters: in stdio mode stdout is the MCP
// JSON-RPC channel and a stray console.log corrupts the stream.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Anything that looks like a credential is redacted before it can reach a log.
const SECRET_FIELD = /key|token|secret|authorization|password|cookie/i;

function formatValue(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return formatValue(value.message);
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "undefined";
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

/**
 * @param {{ level?: keyof LEVELS, stream?: { write: (chunk: string) => unknown } }} [options]
 */
export function createLogger({ level = "info", stream = process.stderr } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(levelName, message, fields) {
    if (LEVELS[levelName] < threshold) return;
    const details = Object.entries(fields ?? {}).map(
      ([key, value]) => `${key}=${SECRET_FIELD.test(key) ? '"[redacted]"' : formatValue(value)}`,
    );
    const line = `${new Date().toISOString()} ${levelName.padEnd(5)} ${message}`;
    stream.write(`${details.length ? `${line} ${details.join(" ")}` : line}\n`);
  }

  return {
    level,
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
