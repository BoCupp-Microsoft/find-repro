# find-repro

Reusable JavaScript classes and two driver entry points for **reproducing errors
in the Microsoft Teams desktop client** (a WebView2 app) on a Teams dev box. The
driver configures the host to run against locally-built web code, launches it so
it can be driven over CDP, executes a variable set of UI operations
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
4. Connect one CDP session and auto-attach to every target (core, windows,
   iframes, workers).
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

Teams opens several WebView2 targets. The first page target is a **non-rendering
core** into which almost all non-worker scripts load; the visible **main window**
(the one that hosts the app bar, on the clean start URL with no `#deepLink` hash)
is opened *from* that core. On a cold start of a **debug build** the main window
can take ~30–60s (sometimes more) to appear and render the app bar — `Session.start`
waits up to `mainWindowTimeoutMs` (default 240s) and logs the targets it sees so the
wait is never a silent black box.

The driver speaks **raw CDP only** (no Playwright). It opens one strongly-typed
browser session (`src/cdpSession.js`) and turns on `Target.setAutoAttach`, so it
attaches to **every** target — the core, the main window, later windows, iframes,
and all workers — with no `/json/list` polling and no reconnecting. Each window/
iframe is driven via `src/cdpTarget.js` (DOM through `Runtime.evaluate`). Page and
worker console arrive through that one session. The main window is the page target
whose app-bar rail is interactive.

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
  "steps": [ { "op": "click", "selector": "[aria-label=\"Calendar\"]" } ],
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
node bin/run.js --steps .\examples\meet-now.json --out .\.session\result.json
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
| `waitForSelector`| `selector` (+ optional `state`)          | `state`: `attached`/`visible`/`actionable` |
| `waitForText`    | `text` (+ optional `exact`, `state`)     | `state`: `attached`/`visible`/`actionable` |
| `sleep`          | `ms`                                     | last resort; prefer `state:"actionable"` |
| `screenshot`     | optional `fullPage`, `path`              | returns `data.path`                     |
| `domSnapshot`    | optional `selector`                      | returns `data.html`                     |
| `switchTarget`   | `selector` / `titlePrefix` / `urlIncludes` | polls incl. new windows; sets active  |

### Actionability & waiting

`click` and `hover` don't fire as soon as the element is found in the DOM — they
wait for it to be **actionable** (what a human needs to actually click it) and for
its hit point to be **stable** across two checks, then dispatch a real CDP `Input`
mouse event at the hit-tested point. "Actionable" means: connected to the DOM,
not `display:none`/`visibility:hidden`/`opacity:0`, not `disabled`/`aria-disabled`,
non-zero box, centre within the viewport (it is scrolled into view first), and the
centre point **hit-tests to the element** (nothing — loading curtain, modal,
overlay — is covering it). This absorbs fade-ins, animations, loading curtains, and
late React hydration, so you rarely need `sleep`.

`waitForSelector`/`waitForText` take an optional `state`:

- `attached` — present in the DOM.
- `visible` (default) — present **and** has a non-zero bounding box. Note this is
  weak: `visibility:hidden`, `opacity:0`, occluded, off-screen, or not-yet-hydrated
  elements still pass.
- `actionable` — the full actionability check above. Prefer this over a `sleep`
  when waiting for something you're about to interact with.

The one wait that actionability can't replace is the **cold-start app settle**: the
session is `ready` once the rail is interactive, but navigating before the SPA has
initialized its app hosts can make an app iframe (e.g. Calendar) load unstably and
detach permanently. There's no clean "SPA fully initialized" event and Teams is too
network-chatty for network-idle to fire, so `examples/meet-now.json` keeps one
documented `sleep` before its first navigation. A retry-on-detach step op could
remove even that.

### Multi-window scenarios

Some actions open a **new window** (e.g. Meet Now → meeting pre-join). Use
`switchTarget` to poll all targets — including newly created ones — for a key
selector, then make the matching window the active page for subsequent steps.
Auto-attach surfaces windows created after the initial attach automatically, so no
reconnect is required.

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
**not** in the page. find-repro's single CDP session (`src/cdpSession.js`)
auto-attaches to every page, iframe, and worker target and folds their console
into observations (`source: "worker"`), so errors logged there (e.g.
`ToastEventIsAlreadyRead`) are captured. This is essential for detecting
worker-emitted errors.

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
src/   config, logger, devServer, configuration, shellLauncher, cdpSession,
       cdpTarget, consoleMonitor, targetManager, stepRunner, session
bin/   serve.js (interactive), run.js (batch), argv.js
examples/  meet-now.json (validated batch flow), request.example.json (serve
           request envelope), drive.js (step-by-step serve driver),
           debug-appbar.js (target diagnostic)
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

