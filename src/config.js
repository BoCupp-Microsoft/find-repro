"use strict";

/**
 * Central configuration for the find-repro driver.
 *
 * All values can be overridden via the `overrides` object (e.g. parsed from CLI
 * args by the bin entry points) or a handful of environment variables. Paths
 * default to the standard Teams dev-box layout described in the project plan.
 */

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

function getLocalAppData() {
  return (
    process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || os.homedir(), "AppData", "Local")
  );
}

/**
 * Resolves the Teams host exe to launch, preferring the dev's locally-built
 * host over the installed Store stub.
 *
 * Order: explicit FIND_REPRO_SHELL_EXE env -> most-recent
 * `<hostRoot>\src\_build\<arch>\<config>\ms-teams.exe` -> WindowsApps stub.
 */
function resolveShellExe(localAppData) {
  if (process.env.FIND_REPRO_SHELL_EXE) return process.env.FIND_REPRO_SHELL_EXE;

  const hostRoot =
    process.env.FIND_REPRO_HOST_ROOT || "Q:\\src\\teams-client-native-shell";
  const built = findBuiltShell(path.join(hostRoot, "src", "_build"));
  if (built) return built;

  return path.join(localAppData, "Microsoft", "WindowsApps", "ms-teams.exe");
}

/** Returns the most recently built ms-teams.exe under <buildRoot>\<arch>\<config>. */
function findBuiltShell(buildRoot) {
  let best = null;
  try {
    for (const arch of safeReaddir(buildRoot)) {
      const archDir = path.join(buildRoot, arch);
      for (const config of safeReaddir(archDir)) {
        const exe = path.join(archDir, config, "ms-teams.exe");
        try {
          const stat = fs.statSync(exe);
          if (!best || stat.mtimeMs > best.mtimeMs) {
            best = { exe, mtimeMs: stat.mtimeMs };
          }
        } catch {
          /* not present in this config */
        }
      }
    }
  } catch {
    /* build root missing */
  }
  return best ? best.exe : null;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

/**
 * Builds a frozen configuration object.
 * @param {object} [overrides] Partial values that take precedence over defaults.
 * @returns {Readonly<object>}
 */
function createConfig(overrides = {}) {
  const localAppData = getLocalAppData();

  const startUrl =
    overrides.startUrl ||
    process.env.FIND_REPRO_START_URL ||
    "https://local.teams.office.com/v2/?skipauthstrap=1";

  const defaults = {
    // Where the Teams host executable lives (prefers the locally-built host).
    shellExe: resolveShellExe(localAppData),

    // Host configuration.json that points the shell at locally-built web code.
    configJsonPath: path.join(
      localAppData,
      "Microsoft",
      "MSTeams",
      "configuration.json"
    ),

    // Required keys merged into configuration.json.
    requiredConfig: {
      "core/devMenuEnabled": true,
      "core/startPage": startUrl,
    },

    // Locally running web server we verify (but never start).
    startUrl,

    // Chromium remote-debugging port exposed by the WebView2 host.
    cdpPort: Number(process.env.FIND_REPRO_CDP_PORT) || 9222,

    // Conflict policy for configuration.json when running non-interactively
    // (no TTY to prompt). false => keep existing values; true => overwrite.
    overwriteConflicts: false,

    // Host instance management.
    // Reuse a host already exposing the CDP port instead of launching anew.
    reuseExisting: true,
    // Terminate a conflicting non-debug ms-teams instance before launching.
    killExisting: false,

    // Main Teams window detection. The default app (Chat/Calendar/...) varies,
    // so the app bar (left rail) is the reliable signal; the title prefix is
    // only an optional tie-breaker.
    mainWindowTitlePrefix: null,
    // App-bar selectors (ranked) used to recognise the main window's left rail.
    // Verified against teams-modular-packages.
    appBarSelectors: [
      '[data-tid="app-bar-wrapper"]',
      '[data-tid="app-layout-area--nav"]',
      '[data-tid^="app-bar-"]',
    ],
    // The window is only "ready" once the rail is populated and interactive, not
    // merely once the (initially empty) app-bar wrapper exists in the DOM. We
    // require at least this many real rail app buttons (Activity/Chat/Calendar/
    // ...); during loading only the overflow button is present.
    minAppBarItems: 3,

    // Extra Chromium flags passed to the WebView2 host. The anti-throttling
    // flags keep the renderer painting/running even when the window is occluded
    // or unfocused (otherwise the shell can stall behind the loading curtain
    // while we drive it in the background).
    extraBrowserArgs: [
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],

    // Working directory for the interactive request/response file protocol and
    // for screenshots. Defaults to a `.session` folder next to the package.
    sessionDir:
      process.env.FIND_REPRO_SESSION_DIR ||
      path.join(process.cwd(), ".session"),

    // Timeouts / polling (milliseconds).
    cdpConnectTimeoutMs: 60000,
    // Cold starts can take a while to render the shell; allow generous time.
    mainWindowTimeoutMs: 240000,
    // How often to log seen targets while waiting for the main window.
    mainWindowReportIntervalMs: 5000,
    targetPollIntervalMs: 1000,
    // How often the long-lived CDP session reconciles its tracked targets
    // against Target.getTargets() to recover windows missed by auto-attach.
    targetReconcileIntervalMs: 1500,
    switchTargetTimeoutMs: 30000,
    stepTimeoutMs: 30000,
    // Interactive serve loop poll interval for new request files.
    requestPollIntervalMs: 250,
    // Per-command CDP timeout so a stuck target session can't stall polling.
    cdpCommandTimeoutMs: 10000,
  };

  const merged = { ...defaults, ...overrides };

  // Keep requiredConfig in sync if caller overrode startUrl but not requiredConfig.
  if (overrides.startUrl && !overrides.requiredConfig) {
    merged.requiredConfig = {
      ...merged.requiredConfig,
      "core/startPage": overrides.startUrl,
    };
  }

  return Object.freeze(merged);
}

module.exports = { createConfig, getLocalAppData };
