# find-repro

Reusable JavaScript classes and two driver entry points for **reproducing errors
in the Microsoft Teams desktop client** (a WebView2 app) on a Teams dev box. The
driver configures the host to run against locally-built web code, launches it so
Playwright can drive it over CDP, executes a variable set of UI operations
("steps"), and reports console output + observations so an AI-powered skill can
confirm or refine a hypothesis about where an error originates.

The script **does not start the web dev server** (that is slow and owned by the
dev) — it only verifies the server is reachable.

## Prerequisites

- A Teams dev box with local enlistments:
  - Host: `Q:\src\teams-client-native-shell`
  - Web: `Q:\src\teams-modular-packages`
- The Teams web dev server already running at
  `https://local.teams.office.com/v2/?skipauthstrap=1`
  (start it yourself, e.g. `yarn start:rspack react-web-client`, and leave it running).
- `ms-teams.exe` installed (default: `%LOCALAPPDATA%\Microsoft\WindowsApps\ms-teams.exe`).
- Node.js >= 20. Dependencies installed (`npm install`).

## What it does on boot (`Session.start`)

1. Verify the dev server is reachable (fails fast otherwise).
2. Merge required keys into `%LOCALAPPDATA%\Microsoft\MSTeams\configuration.json`:
   ```json
   { "core/devMenuEnabled": true,
     "core/startPage": "https://local.teams.office.com/v2/?skipauthstrap=1" }
   ```
   Missing keys are added silently; a conflicting value prompts when a TTY is
   present, otherwise honours `--overwrite-conflicts` (default: keep existing).
3. Ensure an attachable host is running:
   - if the CDP port is already open, **reuse** that instance (`--no-reuse` to
     opt out);
   - otherwise launch `ms-teams.exe` (preferring the locally-built host) with the
     CDP port exposed via
     `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`.
     Teams is **single-instance**, so a different instance already running
     without the debug port is reported; pass `--kill-existing` to terminate it
     first.
4. Wait for the **Teams content window** to exist, then attach Playwright.
5. Wait for the **main Teams window to be interactive** — not just present. The
   app-bar wrapper exists in the DOM early, behind the "We're setting things up…"
   loading curtain, while the rail holds only the overflow button. Readiness
   requires the rail (`app-layout-area--nav`) to be visible **and populated with
   the real app buttons** (Activity, Chat, Calendar, …) — at least
   `minAppBarItems` of them (default 3). This is what prevents clicks from firing
   before the shell is usable.

### Targeting app-bar (left rail) buttons

The rail's app buttons use **app-GUID `data-tid`s** (e.g. Calendar is
`ef56c0de-36fc-4ef8-b417-3d82ba9d073c`) — **not** `data-tid="app-bar-calendar"`.
Target them by their stable **`aria-label`** instead:

```json
{ "op": "click", "selector": "[aria-label=\"Calendar\"]" }
```

Known labels: `Activity`, `Chat`, `Calendar`, `Calls`, `OneDrive`, `Copilot`,
`Apps`. The only `app-bar-*` tid on the rail is `app-bar-overflow` /
`appbar-flyout-button` ("View more apps").

### Important boot timing & window model

Teams opens several WebView2 targets. The one that hosts the app bar is a page
on the **clean start URL** (no `#deepLink` hash); a separate `#deepLink`
orchestration page exists with an empty `#app` and should be ignored. On a cold
start of a **debug build** the content window can take ~30–60s (sometimes more)
to appear and render the app bar — `Session.start` waits up to
`mainWindowTimeoutMs` (default 240s) and logs the targets it sees every 5s so the
wait is never a silent black box.

Because Playwright's `connectOverCDP` only surfaces page targets that exist *at
connect time*, the driver first discovers the content window via the raw CDP
`/json/list` endpoint before connecting. For windows opened **later** (multi-
window scenarios, see below) it transparently reconnects so Playwright picks them
up.

## Two modes

### Interactive / serve mode (primary)

Keeps the host alive and exchanges one request/response per step batch via files
in the session directory — ideal for a skill iterating on a hypothesis without
paying the host-boot cost each time.

```bash
node bin/serve.js --session-dir .\.session
```

Files in `<sessionDir>`:

| File            | Written by | Purpose                                            |
| --------------- | ---------- | -------------------------------------------------- |
| `status.json`   | driver     | `{ state: starting\|ready\|error\|stopped, ... }`  |
| `request.json`  | skill      | a request (below); `id` must change each time      |
| `response.json` | driver     | the matching response (same `id`)                  |

**Request**:
```json
{ "id": "req-0001",
  "steps": [ { "op": "click", "selector": "[data-tid=\"app-bar-calendar\"]" } ],
  "options": { "wantDom": false, "wantScreenshot": false,
               "continueOnError": false, "expectations": [ ... ] } }
```
or `{ "id": "...", "type": "shutdown" }`.

**Response**:
```json
{ "id": "req-0001", "status": "ok",
  "mainWindow": { "title": "...", "url": "..." },
  "results": [ <observation>, ... ] }
```

### Batch / replay mode

Runs a full steps file to completion and writes a result file; exits 0 if every
step passed, 1 otherwise.

```bash
node bin/run.js --steps .\examples\steps.example.json --out .\.session\result.json
```

## Step operations

Every step is `{ "op": "<name>", ... }`. Target an element with **one** of
`selector` (CSS), `testId` (data-testid), or `text` (visible text). Add an
optional `target` (`{ selector?, titlePrefix?, urlIncludes? }`) to run a single
step against a non-active page without changing the active page.

| op               | fields                                   | notes                                   |
| ---------------- | ---------------------------------------- | --------------------------------------- |
| `click`          | selector/testId/text                     |                                         |
| `fill`           | selector + `value`                       | replaces field contents                 |
| `type`           | selector + `value`                       | types key-by-key                        |
| `press`          | `key` (+ optional selector)              | e.g. `"Enter"`                          |
| `hover`          | selector/testId/text                     |                                         |
| `selectOption`   | selector + `value`                       |                                         |
| `goto`           | `url` (+ optional `waitUntil`)           |                                         |
| `evaluate`       | `expression`                             | returns `data.result`                   |
| `waitForSelector`| `selector` (+ optional `state`)          |                                         |
| `waitForText`    | `text` (+ optional `exact`)              |                                         |
| `sleep`          | `ms`                                     |                                         |
| `screenshot`     | optional `fullPage`, `path`              | returns `data.path`                     |
| `domSnapshot`    | optional `selector`                      | returns `data.html`                     |
| `switchTarget`   | `selector` / `titlePrefix` / `urlIncludes` | polls incl. new windows; sets active  |

### Multi-window scenarios

Some actions open a **new window** (e.g. Meet Now → meeting pre-join). Use
`switchTarget` to poll all targets — including newly created ones — for a key
selector, then make the matching window the active page for subsequent steps.
The driver reconnects Playwright as needed to surface windows created after the
initial attach.

## Observation (per step)

```json
{
  "op": "click",
  "stepIndex": 1,
  "status": "ok",
  "page": { "title": "...", "url": "..." },
  "console": [ { "seq": 12, "ts": "...", "source": "console",
                 "level": "error", "text": "...", "page": { "url": "..." } } ],
  "data": { ... },          // op-specific (evaluate result, screenshot path, html)
  "dom": "<html>...",       // only when options.wantDom
  "screenshot": "<path>",   // only when options.wantScreenshot
  "expectations": [ { "name": "repro-marker", "matched": true, "entry": {...} } ]
}
```

`console` contains only the lines produced **during that step**. Sources include
`console` (main-page console), `pageerror` (uncaught page errors), `host` (the
ms-teams.exe process stdio), and **`worker`** (Web Worker targets — see below).
`expectations` (optional, per request) are named regex patterns evaluated against
all captured console text — a convenient way to assert a repro/marker appeared.

### Web Worker console capture

Teams runs critical logic — the Conversation Data Layer (CDL), the
notification/**toast** resolvers, and telemetry — in **separate Web Worker
targets** (`precompiled-web-worker-*.js`, `precompiled-telemetry-web-worker.js`),
**not** in the page. Playwright's `page.on('console')` and `page.workers()` do
**not** surface these, so errors logged there (e.g. `ToastEventIsAlreadyRead`)
are invisible to a page-only listener. find-repro attaches to every worker target
over a raw CDP WebSocket and folds their console into observations as
`source: "worker"`. This is essential for detecting worker-emitted errors.

## Configuration overrides

CLI flags (both entry points): `--session-dir`, `--cdp-port`, `--start-url`,
`--shell-exe`, `--config-json`, `--overwrite-conflicts`, `--kill-existing`,
`--no-reuse`. Env vars: `FIND_REPRO_SESSION_DIR`, `FIND_REPRO_CDP_PORT`,
`FIND_REPRO_START_URL`, `FIND_REPRO_SHELL_EXE`, `FIND_REPRO_HOST_ROOT`,
`LOCALAPPDATA`. See `src/config.js` for all defaults.

The host exe is auto-resolved in this order: `--shell-exe`/`FIND_REPRO_SHELL_EXE`
→ most-recent `<host-root>\src\_build\<arch>\<config>\ms-teams.exe` (locally
built host) → the installed `%LOCALAPPDATA%\Microsoft\WindowsApps\ms-teams.exe`
stub.

## Layout

```
src/   config, logger, devServer, configuration, shellLauncher, cdp,
       cdpTargets, consoleMonitor, workerMonitor, targetManager, stepRunner, session
bin/   serve.js (interactive), run.js (batch), argv.js
examples/  steps.example.json, request.example.json
confirmed/ validated step sequences (meet-now flow, endEntity repro)
repros/    skill output: handoff artifacts (SCHEMA.md) + runnable steps
.github/skills/find-repro/  the find-repro skill (SKILL.md)
```

## Skill

`.github/skills/find-repro/SKILL.md` defines the **find-repro skill**: given a raw
error-message string, it locates the error's source, determines its emit conditions and
callers, forms hypotheses, then drives this infra in **serve mode** to reproduce the error,
reduce it to a **minimum repro**, validate it, and write a **handoff artifact** under
`repros/<slug>/` (schema: `repros/SCHEMA.md`) for a downstream fix skill. A worked example
lives in `repros/end-entity-chatthread/`.

### Marker-injection convention

When the skill cannot tell from existing console output whether a suspected code path was
reached, it may add a **temporary** marker at the suspected source line:

```ts
console.error("[[FIND-REPRO:<slug>]] reached <symbol>");
```

detected via an expectation `"\\[\\[FIND-REPRO:<slug>\\]\\]"`. Markers use this unique,
greppable tag, are recorded in the artifact's `evidence.markersUsed`, and **must always be
reverted before finishing** — the skill verifies a clean `git status` in the affected repo.
The skill never starts the web dev server, never commits, and never weakens product code.

