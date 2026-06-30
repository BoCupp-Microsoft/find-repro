"use strict";

/**
 * Tiny timestamped logger. Everything goes to stderr so that stdout can stay
 * reserved for structured machine-readable output when a bin entry point needs
 * it.
 */

function timestamp() {
  return new Date().toISOString();
}

class Logger {
  /** @param {string} [prefix] Optional tag prefixed to every line. */
  constructor(prefix = "") {
    this.prefix = prefix;
  }

  /** Returns a child logger that adds an extra tag. */
  child(tag) {
    const combined = this.prefix ? `${this.prefix}:${tag}` : tag;
    return new Logger(combined);
  }

  log(...args) {
    const tag = this.prefix ? ` [${this.prefix}]` : "";
    process.stderr.write(`${timestamp()}${tag} ${formatArgs(args)}\n`);
  }

  warn(...args) {
    this.log("WARN", ...args);
  }

  error(...args) {
    this.log("ERROR", ...args);
  }
}

function formatArgs(args) {
  return args
    .map(a => (typeof a === "string" ? a : safeStringify(a)))
    .join(" ");
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const defaultLogger = new Logger();

module.exports = { Logger, defaultLogger };
