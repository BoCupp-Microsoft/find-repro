import https from "node:https";
import http from "node:http";

/**
 * Verifies that the locally-managed Teams web dev server is reachable.
 *
 * The script never starts the server (it is slow and owned by the dev); it only
 * confirms something is listening and serving so we fail fast with a helpful
 * message otherwise.
 */
class DevServerChecker {
  /**
   * @param {object} config
   * @param {import("./logger.mjs").Logger} [logger]
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Resolves if the dev server answers (any HTTP status counts as "up").
   * Rejects with guidance if the connection fails.
   * @returns {Promise<void>}
   */
  check() {
    const url = this.config.startUrl;
    const transport = url.startsWith("https:") ? https : http;

    return new Promise((resolve, reject) => {
      // Self-signed dev cert -> rejectUnauthorized: false.
      const req = transport.get(url, { rejectUnauthorized: false }, res => {
        // Any HTTP status proves the server is up and serving.
        res.resume();
        if (this.logger) {
          this.logger.log(`dev server reachable at ${url} (status ${res.statusCode})`);
        }
        resolve();
      });
      req.on("error", err => {
        reject(
          new Error(
            `Dev server not reachable at ${url}: ${err.message}. ` +
              `Start it first (e.g. "yarn start react-web-client") and leave it running.`
          )
        );
      });
    });
  }
}

export { DevServerChecker };
