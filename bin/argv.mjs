/**
 * Minimal CLI arg parser shared by the bin entry points. Translates flags into
 * Session settings overrides (see src/settings.mjs).
 *
 *   --session-dir <path>     -> sessionDir
 *   --cdp-port <n>           -> cdpPort
 *   --start-url <url>        -> startUrl (also updates requiredConfig start page)
 *   --shell-exe <path>       -> shellExe
 *   --config-json <path>     -> configJsonPath
 *   --overwrite-conflicts    -> overwriteConflicts = true
 */
function parseArgs(argv) {
  const overrides = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--session-dir":
        overrides.sessionDir = argv[++i];
        break;
      case "--cdp-port":
        overrides.cdpPort = Number(argv[++i]);
        break;
      case "--start-url":
        overrides.startUrl = argv[++i];
        break;
      case "--shell-exe":
        overrides.shellExe = argv[++i];
        break;
      case "--config-json":
        overrides.configJsonPath = argv[++i];
        break;
      case "--overwrite-conflicts":
        overrides.overwriteConflicts = true;
        break;
      case "--kill-existing":
        overrides.killExisting = true;
        break;
      case "--no-reuse":
        overrides.reuseExisting = false;
        break;
      default:
        // Ignore unknown args (the run entry handles its own flags first).
        break;
    }
  }
  return overrides;
}

export { parseArgs };
