---
name: find-repro
description: 'Use when the user provides a raw error-message string emitted from the Teams codebase (teams-modular-packages or teams-client-native-shell) and wants to reproduce it in the running product. Locates the error source, determines emit conditions and callers, forms hypotheses, then drives the find-repro CDP infrastructure in serve mode to reproduce the error, reduce it to a minimum repro, validate it, and emit a handoff artifact for a downstream fix skill. Drives the locally-built Teams WebView2 host via CDP. Not for unit tests or for producing fixes.'
argument-hint: 'Paste the raw error message string (exactly as emitted in the console/telemetry) that you want reproduced.'
---

# Find Repro

## Goal

Given **one raw error-message string** emitted from the Teams codebase, **do whatever it takes**
(short of unsafe actions — see Constraints) to reproduce that error in the running Teams desktop
client by driving the **`find-repro` CDP infrastructure** (this repo) in **serve mode**,
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
- Node is available; `ws` is installed under `find-repro\node_modules`.

## The engine: find-repro serve mode

Read `README.md` for the full contract. Operationally:

- Boot once: `node bin/serve.mjs --session-dir <dir>` (default `<dir>` is `.\.session`).
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

> **Per-step `console[]` vs cumulative `expectations[]`.** Within one serve session the
> `expectations[]` matches are evaluated against the **entire accumulated console buffer**, so once
> a marker has fired this session an expectation stays `matched: true` on every later batch. To
> attribute an emit to a **specific** action, count the marker in that step's `console[]` (only the
> *new* lines for that step), **not** the expectation flag. Each `bin/run.mjs` run is a fresh
> process, so its buffer is per-run — handy for clean, independent trials.

> **Where errors are logged matters.** `console[]` entries carry a `source`:
> `console` (main page), `pageerror`, `host` (ms-teams.exe stdio), and **`worker`**.
> Teams runs the CDL, the **notification/toast resolvers**, and telemetry in
> separate **Web Worker** targets — find-repro captures those too (`source:"worker"`).
> When locating an error's source, check whether the file lives under a `worker/`
> path (e.g. `data-resolvers-*/.../worker/...`); such errors only surface via the
> worker source, and may be **event-driven** (see below).

> **Markers in product code require a host restart to take effect.** When you inject a
> marker (or any temporary edit) into the Teams web code, the **running host is still
> serving the previously-compiled bundle** — your change does nothing until the dev
> server rebuilds it and the host reloads. After editing, let the dev-server rebuild
> finish, then **shut down and restart the host** (`bye`, then re-boot serve) so it
> picks up the recompiled code. This matters most for **worker** bundles. Budget for a
> rebuild + cold start on every marker iteration; if a freshly-added marker never
> appears, a stale bundle is the first thing to suspect.

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
  Calendar URL). Use `switchTarget` with `titlePrefix`/`selector`/`urlIncludes`; auto-attach
  surfaces windows opened after boot and the match becomes the active page.
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
- **A single error string often has many emit sites — enumerate all of them, and rank by
  severity.** Error *codes* (enums like `SomeLoggingCodes.X`, shared message prefixes) are
  frequently emitted from multiple places, sometimes at different log levels — an
  error/telemetry call at one site, a plain info `log` at another. Grep the **whole code/enum
  name** (not just one message) to list every site, and note each one's **severity**
  (telemetry/error vs info-only `log`) and which mapper/component owns it. Choose the target
  deliberately: the most-reproducible site may be benign info-level noise, while the site the
  report actually cares about is a rarer, higher-severity sibling. Don't fixate on the first match.
- Derive a robust **detection regex** that matches the error but tolerates dynamic substrings
  (ids, names). This regex powers the serve `expectations`. Prefer the distinctive literal
  core (e.g. `endEntity is requesting endEntity`), not the whole line.
- If zero matches: report that and ask the user to confirm the wording / source repo. Stop.

### 2. Determine emit conditions — the predicate gates you must defeat

The error line almost always sits behind a chain of **guards**: nested `if`s, `&&` conditions,
`switch` cases, early-returns, and feature flags between the function's entry and the emit line.
Control flow reaches the error only if **every** guard resolves the way that leads there. Treat
each guard as a gate you must **defeat**, one at a time, by controlling its inputs/state.

- **Enumerate the gates.** Read the emitting function and list, in order, every
  predicate/branch/early-return on the path to the emit line. For each, record the **concrete
  condition** and the input/state that drives control flow *toward* the error (and which
  early-returns you must avoid). This list is your checklist while driving — each failed attempt is
  usually one gate you haven't defeated yet.
- **Read each predicate as a state variable.** A guard like `if (event.isRead)` or
  `if (entity.type === X)` literally names the state that must hold. Note the exact field(s) it
  reads — those are the variables your repro has to control.
- **The emit site's unit test is a precondition oracle.** The function's `*.test.ts` usually
  constructs the minimal input that satisfies the guards. Titles and the odd-one-out case are gold
  (e.g. one case titled "should discard already read events" passing `isRead: true` while every
  other uses `false` reveals `isRead: true` is the triggering input). Read it to learn the gates'
  required values for free.
- **When normal data passes every gate, instrument the gate's *inputs* — not just whether it
  fired.** A boolean "reached / not-reached" marker is nearly useless when ordinary entities clear
  all the guards. Instead, log the **actual field/state values the predicate reads, for every item
  the function processes** (a field-presence / value dump placed just before the guard). Driving
  normal product activity then prints the real input distribution, which usually reveals *which
  specific value* on *which item* defeats the gate — handing you the repro directly, instead of
  guessing. This is the single highest-leverage move when "I can't get the guard to fire."
- Record the gate chain as structured `emitConditions` (prose + the concrete predicates).

### 3. Reach the emit site — a call chain or an event you must produce

Defeating the predicate gates only matters once the function actually **runs**. So determine how it
gets invoked and how *you* can cause that from the running product. Two cases — identify which:

- **Direct call chain → UI.** Walk up the call graph from the emit site to a UI-reachable entry
  point (a click / navigation / render). Identify which components/surfaces invoke the path and
  under what props/state, and note the most likely user-facing trigger(s).
- **Event-driven invocation.** If the function is an **event/message handler** — a Web Worker
  message handler, a subscription callback, a longpoll/push handler (common for CDL, toast, and
  telemetry resolvers under `worker/` paths) — it is **not** reached by a direct call; it runs when
  an **event fires**. Here the gate is the event itself: determine **what fires it**, then work out
  whether you can **generate that event yourself** through an action you can take (the user action
  that makes the server push it, or the state change that re-delivers it). Only if producing the
  event strictly requires something outside this one client (an external sender, a second
  account/machine, background server timing) do you record that as the blocker.
- **Displaying an entity is NOT invoking its handler.** A per-item handler (mapper, resolver,
  reducer) runs when the item's **event is delivered** to it — typically a push/subscription/
  re-emit — *not* when the UI surface that **renders** that item is opened. Opening the feed/list
  that shows the entity makes it visible, but usually does **not** push its event through the
  handler; assuming "open the surface = run the handler" sends you down dead-end UI navigation.
  Confirm delivery with a **caller marker on the handler itself** (see Stage 5), not by the item
  appearing on screen.
- **Per-item re-emit is the generic on-demand invocation lever.** When you need a *chosen* entity
  pushed through a per-item handler **now** — for **any** kind of bug, not just state-triggered
  ones (data-shape, content, malformed-field, etc.) — find an action that **re-delivers that one
  item's event**: a read/unread toggle, a re-fetch/refresh of the item, re-selecting it, an
  optimistic mutation that re-emits it. Such a re-emit re-runs the handler on exactly the entity
  you want, decoupled from ambient/external delivery — and it works **regardless of whether the
  toggled state is the actual cause** (the re-delivery is the point; the cause may be the item's
  shape). Prefer this over hoping the feed-load or a server push happens to carry your target item.
  (See "Re-run the pipeline on a chosen item by toggling its state" in Stage 5.)
- **Find what writes the gated state** (bridges back to Stage 2). For a gate on `entity.X`, grep
  for where `X` is set/toggled (mutations, reducers, event producers — e.g. a `toggleRead` mutation
  doing `isRead: !isRead`). If a **user action changes X**, the error is **transition-triggered**:
  the entity's *initial* X is the real precondition and the trigger is the **state flip** — itself
  an action/event you can produce.
- **Watch for fan-out: one input, many parallel consumers.** A single event/input is often
  dispatched to **several handlers at once** (e.g. one feed/event delivered to multiple mappers,
  subscribers, or reducers in parallel), and the same error code can fire from any of them. Map the
  dispatch/fan-out so you instrument **all** the consumers and attribute the emit to the right one —
  otherwise you'll instrument a single handler, see nothing, and wrongly conclude "path not reached"
  when a sibling consumer is the one emitting.
- Record `callers[]` (and, for the event-driven case, the event and exactly how you produce it).

### 4. Form hypotheses

- Produce a **broad, ranked** list of concrete product step-sequences ("open Calendar, click
  Meet now, open the meeting chat rail") predicted to hit the path, grounded in stages 2–3. Each hypothesis = a short rationale + a steps array.
- **Aim wide — generate at least 6–8 hypotheses** before you start driving, and keep adding new
  ones as you learn. Deliberately vary across dimensions: different **surfaces/apps** (Chat,
  Activity, Calendar, Teams/Channels, Calls, Search), different **entity states** (read vs
  unread, empty vs populated, focused vs background), different **entity / payload types**
  (i.e. the *kind* of item or event flowing through the path, not just its state), different
  **timings** (immediately after boot vs after settle, fast vs slow interaction), **multi-step
  journeys**, **window/iframe context** (main window vs a secondary window via `switchTarget`),
  and any **feature-flag or setting** the emit condition depends on. Don't fixate on one theory.
- **When a gate checks a field, the trigger is usually a rarer or structurally-different entity
  type that lacks it.** Common items have the field, so they sail through; deliberately exercise
  the **uncommon / edge / differently-shaped** item types on the same surface (the input dump from
  Stage 2 tells you which type is the odd one out). "Vary the data shape" is often more productive
  than "vary the action."

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

**Calibrate ambient noise first (event-driven/worker errors).** Before trusting any hit, run a
**zero-action baseline**: reach the surface, then watch the same window length with **no
interaction**, and count the target/caller markers. This tells you the background delivery rate
(server pushes, long-poll, sync) so you can tell a *caused* hit from ambient noise. Then **gate
every hit on a same-step caller marker**: an expectation match is only attributable to your action
if your trigger's **caller marker fired in that same step** (per-step `console[]`, not the
cumulative expectation flag). An expectation hit while the caller marker is silent — or that also
appears in the zero-action baseline — was produced by something else (ambient/external), and is
**not** your repro, no matter how exciting. Doing this early stops you anchoring on a flaky
non-causal "hit" and burning the budget defending it.

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
   - **Outcome varies across identical repeats, and the caller/path marker is SILENT on the
     misses** → the trigger is **not your action**: either an **uncontrolled precondition** (an
     entity's initial state you never set up) or an **upstream/external event** (server push,
     long-poll, a second machine/account, background sync). Do **not** just hammer repeats — that
     only helps a *true race* where the path IS reliably reached. Instead **control the
     precondition** (see "Preconditions & state-triggered errors" below) or find what *produces*
     the inbound event and drive that. A caller marker that fires only sometimes, uncorrelated
     with your steps, is the signature of this case.
   - **Not matched, path not reached** → refine the *steps* (next variation) or the *hypothesis*.
4. On miss, exhaust repeats for a suspected race, then step variations, then advance to the next
   hypothesis — and keep generating fresh hypotheses — until reproduced or you have truly
   exhausted plausible ideas.

> Persistence note: identical re-runs and a wide hypothesis search are expected and encouraged.
> Never abandon a promising hypothesis after a single miss when timing/async/event ordering
> could be involved — be stubborn, vary the conditions, and repeat.

#### Preconditions & state-triggered errors

Many errors fire only when an entity is in a particular **initial state** and you then act on it
(a state *transition*) — not on any pure action. If Stage 3 found the gated state is changed by a
user action, or you see the "varies with identical steps + silent caller marker" signature above,
work the precondition explicitly:

- **Self-arm the precondition.** Don't wait for ambient state (and never rely on luck or an
  external actor putting an entity in the right state). Establish it yourself: perform the
  **inverse** action first to force the required state, then the **forward** action to fire the
  error — e.g. mark an item *unread*, then select it to mark it *read*.
- **State-aware selection.** Probe the live DOM/state first (`evaluate`/`domSnapshot`) and target
  an element **known** to be in the required state — e.g. an attribute or `:has()` selector like
  `[data-tid="activity-feed-list-item"]:has(.unread-indicator)` — **not** "the first matching
  element." Selecting the first item often silently picks one already in the wrong state and misses.
- **Confirm causality with a differential A/B.** Hold everything constant and vary **only** the
  suspected precondition across two trials — one predicted hit, one predicted miss — comparing the
  **per-step** marker counts (deltas, per the engine note, not the cumulative expectation flag). A
  clean "fires with X, silent without X" isolates the causal variable and usually converts a flaky
  repro into a deterministic one. Prefer this deterministic repro for the artifact over a flaky
  feed-load-timing variant.
- **Re-run the pipeline on a chosen item by toggling its state.** Flipping an entity's state often
  re-feeds *that specific item* through the processing path on demand — and frequently the toggle
  re-delivers **in either direction** (and back), so you can re-trigger repeatedly without waiting
  for an ambient or external event, and **without depending on the item's current state**. This is
  a reliable way to push one chosen entity (e.g. the rare/edge-shaped item from Stage 4) through the
  code as many times as you need. **This applies even when the read/toggle state is NOT the cause**
  — for a data-shape / malformed-field / content bug, the toggle is just the cheapest way to
  re-deliver your target item to the handler on demand; the cause is the item's shape, the toggle
  is only the delivery mechanism (see Stage 3, "Per-item re-emit is the generic on-demand
  invocation lever").



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
  `node bin/run.mjs --steps repros/<slug>/steps.json --kill-existing`
- Record the observed **hit rate** in the artifact (`validation.runs` / `validation.passed`).
  A deterministic repro should be N/N. An **intermittent** repro that fires on some runs is
  still a valid `reproduced` result — record it as such, set `validation.flaky: true`, and note
  the rate (e.g. 3/10). Do **not** downgrade a real-but-flaky race to `not-reproduced`.

### 8. Emit handoff artifact + report

- Write `repros/<slug>/repro.json` per `repros/SCHEMA.md`, including the runnable `steps.json`
  pointer, evidence (console lines, screenshots), environment, and `handoffForFix` (suspected
  fix locations + how the fix skill should re-validate: replay `steps.json`; the expectation
  must **no longer** match).
- **Populate the human-report fields** (all in `repro.json`, all general — see SCHEMA.md): a
  short `summary[]` (the "how the repro was found" bullets), a `walkthrough[]` (one entry per
  minimum-repro step the report should show), and enrich `evidence.markersUsed[]` with an `id`
  and a `codeContext` snippet (a few lines of surrounding source with the marker line included)
  so the report is self-contained even after markers are reverted. Each `walkthrough` entry
  carries: `title`, the **raw** `screenshot`, optional `annotation` (the click target), a
  `comment`, the `input` performed, any `critical[]` callouts, and `markersObserved`
  (`summary` + the actual `lines` + `markerRefs` into `markersUsed`).
- **Capture the per-step evidence during a capture pass** (reuse the Stage 7 validation, or one
  extra serve run of the minimum repro). For each interaction step, in order:
  1. **Scroll the target into view and center it** (`element.scrollIntoView({block:"center"})`)
     so it is actually visible in the screenshot — off-screen targets produce useless frames.
  2. Capture the **annotation geometry** with an `evaluate`: the element's **rect centre in CSS
     px**, `window.devicePixelRatio`, and `window.innerWidth/innerHeight`
     (`{ point:{xCss,yCss}, dpr, viewport:{w,h}, label }`; `label` e.g. `"click"`/`"right-click"`).
  3. Take a **raw screenshot** to `evidence/stepN.png`, then perform the action.
  4. Record the **markers/console lines** that fire in that step (from the step's `console[]`)
     into the step's `markersObserved`.
  The builder draws the arrow post-hoc from this geometry, so the screenshots stay raw and the
  annotation is reproducible.
- **Generate the report** with the builder (requires Pillow — `pip install Pillow`):
  `python .github/skills/find-repro/scripts/build-report.py --repro repros/<slug>/repro.json`
  It writes `<slug>.html` (self-contained) and `<slug>.linked.html` (references `evidence/`),
  named for the repro slug so shared files have unique names.
- Give the user a concise report: status, source (file:line/symbol), the minimum repro steps,
  the validation result, and the artifact path (including `<slug>.html`).

## Marker discipline (temporary code markers)

- Inject markers to confirm the suspected code path was reached and validate your ability to detect it.
- Use a unique, greppable tag: `console.error("[[FIND-REPRO:<slug>]] reached <symbol>")` placed
  at the suspected line. Detect it with an expectation `"\\[\\[FIND-REPRO:<slug>\\]\\]"`.
- Also place markers to validate the callers or branches leading up to the emit site are being reached (e.g. `console.error("[[FIND-REPRO:<slug>]] caller <symbol>")`).
- **Prefer a field-dump marker over a bare "reached" marker.** Inside (or just before) the guard,
  log the **values the predicate reads** — e.g.
  `console.error("[[FIND-REPRO:<slug>]] guard inputs " + JSON.stringify({fieldA, fieldB, type}))`.
  When normal data clears the gate, this is what tells you *which input on which item* defeats it
  (see Stage 2). When an error has multiple emit sites or parallel consumers, mark **every** site so
  you can attribute the emit correctly (see Stages 1 and 3).
- Record every marker edit in `evidence.markersUsed` (file, line, what was added). Give each an
  `id` and capture a `codeContext` snippet (a few surrounding lines with the marker line included)
  so the human report can show the code next to where the marker fired, even after the marker is
  reverted.
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
- The handoff artifact must be **self-describing**: everything the human report shows (text, code
  context, observed console lines, screenshot-annotation geometry) lives in `repro.json` or files
  it references under `evidence/`, so `<slug>.html` regenerates identically without re-running the
  repro. The report builder requires **Pillow** (`pip install Pillow`).
