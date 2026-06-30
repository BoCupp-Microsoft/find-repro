---
name: find-repro
description: 'Use when the user provides a raw error-message string emitted from the Teams codebase (teams-modular-packages or teams-client-native-shell) and wants to reproduce it in the running product. Locates the error source, determines emit conditions and callers, forms hypotheses, then drives the find-repro Playwright infrastructure in serve mode to reproduce the error, reduce it to a minimum repro, validate it, and emit a handoff artifact for a downstream fix skill. Drives the locally-built Teams WebView2 host via CDP. Not for unit tests or for producing fixes.'
argument-hint: 'Paste the raw error message string (exactly as emitted in the console/telemetry) that you want reproduced.'
---

# Find Repro

## Goal

Given **one raw error-message string** emitted from the Teams codebase, **do whatever it takes**
(short of unsafe actions — see Constraints) to reproduce that error in the running Teams desktop
client by driving the **`find-repro` Playwright infrastructure** (this repo) in **serve mode**,
reduce the interaction to a **minimum repro**, validate it, and write a **handoff artifact** that
a downstream fix skill can consume.

**Be relentless.** Reproducing the error is the primary objective. Generate many varied
hypotheses, retry promising ones repeatedly (especially for races/intermittent errors), explore
different surfaces, states, timings, and conditions, and use markers to confirm code paths and
sharpen your theory. A `not-reproduced` result is a last resort reported only after **genuinely
exhaustive** effort — never an early exit. At the same time, stay **honest**: never fabricate a
repro, and report `partial`/`not-reproduced` truthfully if the error is genuinely out of reach
(e.g. it strictly requires an external sender or a second account).

This skill **reproduces** errors. It does **not** produce fixes. It may make **temporary**
edits to the Teams web code to confirm that the suspect code path is being exercised.  Changes made to the codebase that are not critical to reproducing the error must be reverted before finishing.

## Primary contract

**Input:** exactly one raw error string, e.g.

```
Entities Hierarchy helpers: Someone is trying to access a parent entity, current entity: endEntity is requesting endEntity, fieldsToMatch: action: undefined & type: chatthread
```

**Output:**
- A handoff artifact directory `repros/<slug>/` containing `repro.json` (schema:
  `repros/SCHEMA.md`), a runnable `steps.json`, and captured evidence.
- A concise final report to the user (status, source, minimum repro, how to validate).

When a non-empty error string is provided, start immediately. Do not ask for more context up
front — derive everything from the string and the codebase. Only ask the user if the error
string matches **zero** locations in either repo, or is too generic to form a detection
pattern.

## Environment assumptions (standard Teams dev box)

- Host source: `Q:\src\teams-client-native-shell`; web source: `Q:\src\teams-modular-packages`.
- This infra repo: `Q:\src\find-repro` (run all `node bin/...` commands from here).
- The web dev server is **already running** at `https://local.teams.office.com/v2/?skipauthstrap=1`
  and is **managed by the dev** — never start it; the infra only checks reachability.
- Node is available; `playwright-core` is installed under `find-repro\node_modules`.

## The engine: find-repro serve mode

Read `README.md` for the full contract. Operationally:

- Boot once: `node bin/serve.js --session-dir <dir>` (default `<dir>` is `.\.session`).
  Cold start of the debug host is ~30–60s. Add `--kill-existing` if a non-debug Teams is
  already running; `--no-reuse` to force a fresh launch.
- Poll `<dir>\status.json` until `state` is `ready` (or `error`).
- Drive one step-batch at a time:
  - Write `<dir>\request.json` with a **unique `id`** each time:
    ```json
    { "id": "h1-attempt1",
      "options": { "wantScreenshot": true,
                   "expectations": [ { "name": "target", "pattern": "<regex>", "flags": "i" } ] },
      "steps": [ { "op": "click", "selector": "[aria-label=\"Calendar\"]" } ] }
    ```
  - Read `<dir>\response.json`; act on the matching `id`. The response gives, per step:
    `status`, `error?`, `page {title,url}`, `console[]` (new lines that step),
    `expectations[]` (named matches), and `data`/`dom`/`screenshot` when requested.
- Stop cleanly: write `{ "id": "bye", "type": "shutdown" }` (kills the host process tree).

> **Where errors are logged matters.** `console[]` entries carry a `source`:
> `console` (main page), `pageerror`, `host` (ms-teams.exe stdio), and **`worker`**.
> Teams runs the CDL, the **notification/toast resolvers**, and telemetry in
> separate **Web Worker** targets — find-repro captures those too (`source:"worker"`).
> When locating an error's source, check whether the file lives under a `worker/`
> path (e.g. `data-resolvers-*/.../worker/...`); such errors only surface via the
> worker source, and may be **event-driven** (see below).

### Step ops

`click`, `fill`, `type`, `press`, `hover`, `selectOption`, `goto`, `evaluate`,
`waitForSelector`, `waitForText`, `sleep`, `screenshot`, `domSnapshot`, `switchTarget`.
Target an element with **one** of `selector` (CSS), `testId`, or `text`. A step may carry an
optional `target`/`frameUrlIncludes` to scope it.

### Hard-won targeting rules (do not relearn these)

- **App-bar (left rail) buttons:** target by **`aria-label`** — `[aria-label="Calendar"]`,
  `[aria-label="Chat"]`, `[aria-label="Activity"]`, etc. Their `data-tid` is an app GUID; the
  string `app-bar-calendar` does **not** exist (only `app-bar-overflow`).
- **In-app controls live in iframes.** Teams renders each app (Calendar, Meet, …) inside a
  child iframe. The runner is frame-aware and searches all frames automatically; just give the
  selector. (E.g. Calendar's Meet now = `[aria-label="Start an instant Teams meeting."]`.)
- **When `aria-label` is missing, use `title=` or `data-tid`.** E.g. the meeting invite
  dialog X has `title="Close"` and `data-tid="share_meeting_invite_dialog_dismiss_button"`;
  Leave = `data-tid="hangup-main-btn"`.
- **New windows may share the same URL** (e.g. the Meet now pre-join window shares the
  Calendar URL). Use `switchTarget` with `titlePrefix`/`selector`/`urlIncludes`; it reconnects
  to surface windows opened after boot and makes the match the active page.
- **Readiness** already means "left rail populated with real app buttons", not just the
  wrapper existing — so a `ready` status is safe to click against.
- Reference flow: `confirmed/meet-now.steps.json` (Calendar → Meet now → Start meeting →
  switch to pre-join → Join now → close X → Leave), and the live repro
  `confirmed/endEntity-meeting-chat.repro.json` (open meeting Chat rail → endEntity error 3×).

## Workflow

Execute these stages in order. Keep serve mode alive across the whole run; reset to a known
**baseline** between hypotheses instead of restarting (cold starts are slow).

### 1. Locate the source

- Slugify the error for naming (`<slug>`), e.g. `end-entity-chatthread`.
- Search `teams-modular-packages` first (most UI/console errors), then
  `teams-client-native-shell`. Match on the **stable** part of the message (strip GUIDs/CIDs,
  interpolated values). Find the exact emit site: `repo`, `file`, `line`, enclosing `symbol`,
  and a short `snippet`.
- Derive a robust **detection regex** that matches the error but tolerates dynamic substrings
  (ids, names). This regex powers the serve `expectations`. Prefer the distinctive literal
  core (e.g. `endEntity is requesting endEntity`), not the whole line.
- If zero matches: report that and ask the user to confirm the wording / source repo. Stop.

### 2. Determine emit conditions

- Read the emitting function. Identify the precise branch/guard and the inputs/state that make
  it fire (entity type, slot, action, props, feature flag, async ordering, etc.).
- Record as structured `emitConditions` (prose + the concrete predicate).

### 3. Understand callers

- Walk up the call graph from the emit site to UI-reachable entry points. Identify which
  components/surfaces invoke the path and under what props/state. Note the most likely
  user-facing trigger(s). Record `callers[]`.

### 4. Form hypotheses

- Produce a **broad, ranked** list of concrete product step-sequences ("open Calendar, click
  Meet now, open the meeting chat rail") predicted to hit the path, grounded in stages 2–3. Each hypothesis = a short rationale + a steps array.
- **Aim wide — generate at least 6–8 hypotheses** before you start driving, and keep adding new
  ones as you learn. Deliberately vary across dimensions: different **surfaces/apps** (Chat,
  Activity, Calendar, Teams/Channels, Calls, Search), different **entity states** (read vs
  unread, empty vs populated, focused vs background), different **timings** (immediately after
  boot vs after settle, fast vs slow interaction), **multi-step journeys**, **window/iframe
  context** (main window vs a secondary window via `switchTarget`), and any **feature-flag or
  setting** the emit condition depends on. Don't fixate on one theory.

### 5. Reproduce (persistent loop)

**Try hard. The budgets below are floors, not ceilings** — minimum effort before you may even
consider stopping, not permission to quit early. Keep going while you have untried, plausible
ideas.

**Effort levels:**
- **Outer — hypotheses:** work through **at least 8** distinct theories, and keep generating
  more as findings suggest them. Only stop expanding when you have genuinely run out of
  plausible, materially-different ideas (not when a counter hits a number).
- **Inner, per hypothesis:**
  - try **several step variations** (alternate selectors, added waits, reordering, longer watch
    windows, different entry points), AND
  - **repeat the identical steps many times** (think **5–10+**, more if signal is promising)
    whenever the error could be a **race / intermittent / timing-dependent** condition — i.e.
    event-driven, async-ordered, dependent on server push/long-poll timing, or whenever a marker
    shows the path is reached but the error only sometimes fires. Vary timing/jitter and watch
    windows across repeats to shake loose the race.

Treat a **single** match across any repeat as reproduced (then quantify flakiness in Stage 7).
Escalate effort rather than giving up: widen watch windows, add markers to confirm reachability,
adjust state setup, try adjacent surfaces, and combine clues across hypotheses. Move to
`partial`/`not-reproduced` **only after exhaustive effort**, and when you do, clearly explain
what you tried and exactly what blocks a repro (e.g. requires an external sender / second
account / a specific flag).

For each hypothesis:
1. Ensure serve is `ready`; navigate to the agreed **baseline** (e.g. Chat home, or close any
   open meeting) so attempts are independent — **re-establish the baseline before every repeat**
   so each run is a clean, independent trial.
2. Submit the steps with the detection `expectation` attached; request `wantScreenshot` on the
   final step for evidence.
3. Evaluate the response:
   - **Expectation matched** → reproduced. Record the exact steps + console evidence (and note
     on which repeat it fired, so flakiness is captured).
   - **Not matched, unsure the path was even reached** → **inject a temporary marker** (see
     "Marker discipline"), re-run, and check for the marker in console. This tells you whether to
     refine the *steps* (path not reached) or the *hypothesis* (path reached but condition not
     met). **Revert the marker** if it did not help; otherwise leave it in place for later review by the dev when considering evidence.
   - **Not matched, path reached but no error (marker fired, expectation did not)** → strong
     signal of a **race**: hammer the identical steps many times (widen the post-action watch
     window, add timing jitter, vary preconditions) before concluding. This is the case to be
     most stubborn about.
   - **Not matched, path not reached** → refine the *steps* (next variation) or the *hypothesis*.
4. On miss, exhaust repeats for a suspected race, then step variations, then advance to the next
   hypothesis — and keep generating fresh hypotheses — until reproduced or you have truly
   exhausted plausible ideas.

> Persistence note: identical re-runs and a wide hypothesis search are expected and encouraged.
> Never abandon a promising hypothesis after a single miss when timing/async/event ordering
> could be involved — be stubborn, vary the conditions, and repeat.



### 6. Minimum repro reduction

Once reproduced, delta-debug the winning step sequence: remove or merge steps one at a time
and re-validate after each change (the expectation must still match). For an **intermittent /
race** repro, re-validate each candidate reduction across **several repeats** (not just once)
before accepting it — a step is only safe to drop if its removal does not lower the hit rate.
Keep the **shortest** sequence that still emits the error. Record it as `minimumRepro`.

### 7. Validate

- Write the minimum repro to `repros/<slug>/steps.json` (standard find-repro steps schema with
  the detection `expectation` in `options`).
- Validate with a clean batch run, repeated (default **3×** for a deterministic repro; use
  **more** repeats — e.g. 5–10 — for an intermittent/race repro to measure stability):
  `node bin/run.js --steps repros/<slug>/steps.json --kill-existing`
- Record the observed **hit rate** in the artifact (`validation.runs` / `validation.passed`).
  A deterministic repro should be N/N. An **intermittent** repro that fires on some runs is
  still a valid `reproduced` result — record it as such, set `validation.flaky: true`, and note
  the rate (e.g. 3/10). Do **not** downgrade a real-but-flaky race to `not-reproduced`.

### 8. Emit handoff artifact + report

- Write `repros/<slug>/repro.json` per `repros/SCHEMA.md`, including the runnable `steps.json`
  pointer, evidence (console lines, screenshots), environment, and `handoffForFix` (suspected
  fix locations + how the fix skill should re-validate: replay `steps.json`; the expectation
  must **no longer** match).
- Give the user a concise report: status, source (file:line/symbol), the minimum repro steps,
  the validation result, and the artifact path.

## Marker discipline (temporary code markers)

- Inject markers to confirm the suspected code path was reached and validate your ability to detect it.
- Use a unique, greppable tag: `console.error("[[FIND-REPRO:<slug>]] reached <symbol>")` placed
  at the suspected line. Detect it with an expectation `"\\[\\[FIND-REPRO:<slug>\\]\\]"`.
- Also place markers to validate the callers or branches leading up to the emit site are being reached (e.g. `console.error("[[FIND-REPRO:<slug>]] caller <symbol>")`).
- Record every marker edit in `evidence.markersUsed` (file, line, what was added).
- Revert the markers that weren't important to the repro but leave the ones that were critical to detecting the repro for review by the dev.
- Never commit, never push, never start the dev server, never weaken/disable product code.

## Inputs to ask for only if missing

- The raw error string (required). If empty, ask for it.
- Only if the string matches zero source locations: ask the user to confirm exact wording or
  which repo emits it.

## Constraints

- This skill is **repro only** — never attempt a fix.
- Never start the web dev server; never commit or push.
- Keep all generated artifacts under `find-repro/repros/`.
- **Try hard before giving up.** Exhaust varied hypotheses and generous repeats; a
  `not-reproduced`/`partial` result is acceptable **only after genuinely exhaustive effort** and
  must explain what blocks the repro. Never fabricate a repro, and never quit early.
- Treat the task as incomplete until either a validated (possibly intermittent) minimum repro +
  artifact exists, or a clear best-progress report is produced **after exhaustive effort**.
