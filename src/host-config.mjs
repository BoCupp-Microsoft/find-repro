import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * Manages the Teams host's on-disk `configuration.json` — ensures it contains
 * the keys required to run against locally-built web code, while preserving
 * everything else. Distinct from settings.mjs, which holds the driver's own
 * in-memory settings (this manager *consumes* settings.requiredConfig /
 * settings.configJsonPath to write that external file).
 *
 * Merge policy:
 *   - missing keys are added silently;
 *   - a key whose value differs is a *conflict*: prompt to overwrite when a TTY
 *     is available, otherwise honour config.overwriteConflicts (default false).
 */
class HostConfigManager {
  /**
   * @param {object} config
   * @param {object} [deps]
   * @param {import("./logger.mjs").Logger} [deps.logger]
   * @param {(question: string) => Promise<boolean>} [deps.promptYesNo]
   */
  constructor(config, { logger, promptYesNo } = {}) {
    this.config = config;
    this.logger = logger;
    this.promptYesNo = promptYesNo || defaultPromptYesNo;
  }

  log(msg) {
    if (this.logger) this.logger.log(msg);
  }

  /**
   * @returns {Promise<string>} A human-readable summary of what happened.
   */
  async ensure() {
    const configPath = this.config.configJsonPath;
    const required = this.config.requiredConfig;

    let existing = {};
    let fileExisted = false;

    if (fs.existsSync(configPath)) {
      fileExisted = true;
      const raw = fs.readFileSync(configPath, "utf-8");
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("file is not a JSON object");
        }
        existing = parsed;
      } catch (err) {
        this.log(`Existing ${configPath} could not be parsed (${err.message}).`);
        const replace = await this.promptYesNo(
          "Replace it with a fresh file containing only the required keys?",
          this.logger
        );
        if (!replace) {
          throw new Error(
            "Aborted: configuration.json is unparseable and replacement was declined."
          );
        }
        existing = {};
        fileExisted = false;
      }
    }

    const missing = [];
    const conflicts = [];
    for (const key of Object.keys(required)) {
      if (!(key in existing)) {
        missing.push(key);
      } else if (!valuesEqual(existing[key], required[key])) {
        conflicts.push(key);
      }
    }

    if (missing.length === 0 && conflicts.length === 0) {
      return `configuration.json already correct (${configPath})`;
    }

    // Missing keys are added without prompting (nothing is overwritten).
    const keysToWrite = [...missing];

    if (conflicts.length > 0) {
      this.log(`configuration.json has conflicting values at ${configPath}:`);
      for (const key of conflicts) {
        this.log(
          `  ${key}: current=${JSON.stringify(existing[key])} ` +
            `desired=${JSON.stringify(required[key])}`
        );
      }
      let overwrite;
      if (process.stdin.isTTY) {
        overwrite = await this.promptYesNo(
          `Overwrite the ${conflicts.length} conflicting key(s) above?`,
          this.logger
        );
      } else {
        overwrite = Boolean(this.config.overwriteConflicts);
        this.log(
          `Non-interactive: overwriteConflicts=${overwrite}; ` +
            `${overwrite ? "overwriting" : "keeping existing"} conflicting key(s).`
        );
      }
      if (overwrite) {
        keysToWrite.push(...conflicts);
      } else {
        this.log(
          "Keeping existing values for the conflicting key(s); the host may not target local web code as expected."
        );
      }
    }

    if (keysToWrite.length === 0) {
      return `configuration.json left unchanged (${configPath})`;
    }

    const updated = { ...existing };
    for (const key of keysToWrite) {
      updated[key] = required[key];
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), "utf-8");

    const action = fileExisted ? "updated" : "wrote";
    return `${action} ${configPath} (set: ${keysToWrite.join(", ")})`;
  }
}

function valuesEqual(a, b) {
  if (a === b) return true;
  // Tolerate structural equality for object/array values.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Asks a yes/no question on the terminal. Assumes "no" when non-interactive. */
function defaultPromptYesNo(question, logger) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {
      if (logger) logger.log(`${question} -> no interactive terminal, assuming "no".`);
      resolve(false);
      return;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${question} (y/N) `, answer => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export { HostConfigManager, defaultPromptYesNo };
