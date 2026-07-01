# Repro handoff artifact schema

Each successful (or attempted) repro produces a directory:

```
repros/<slug>/
  repro.json          # the handoff artifact (schema below)
  steps.json          # runnable find-repro steps for the minimum repro
  evidence/           # raw + annotated screenshots and any captured console dumps
  <slug>.html         # self-contained human report (images base64-embedded) — generated
  <slug>.linked.html  # lightweight report that references evidence/*.png — generated
```

`<slug>.html` / `<slug>.linked.html` are produced from `repro.json` by the report builder
(`.github/skills/find-repro/scripts/build-report.py`; see "Human report" below). They are a pure
projection of the artifact — everything they display is stored in `repro.json` (or referenced from
`evidence/`), so the artifact remains the single source of truth.

`<slug>` is a kebab-case slug derived from the error (e.g. `end-entity-chatthread`).

The `find-repro` skill writes these. A downstream **fix skill** consumes `repro.json` to
implement and validate a fix — it can replay `steps.json` unchanged (via serve or
`node bin/run.js --steps repros/<slug>/steps.json`) and assert the error no longer fires.

## `repro.json`

```jsonc
{
  // Overall outcome of the repro attempt.
  "status": "reproduced | not-reproduced | partial",

  // The error we were asked to reproduce.
  "error": {
    "message": "<raw input string, verbatim>",
    "detectionPattern": "<regex matching the stable core of the message>",
    "flags": "i",
    "codeName": "optional: the error code/enum name, e.g. SomeLoggingCodes.SomeError",
    "severity": "optional: how/where it is logged, e.g. 'errorToTelemetry in a Web Worker target'"
  },

  // Where the error is emitted in the codebase.
  "source": {
    "repo": "teams-modular-packages | teams-client-native-shell",
    "file": "packages/.../foo.ts",
    "line": 0,
    "symbol": "enclosingFunctionOrComponent",
    "snippet": "the emitting line(s), trimmed"
  },

  // What conditions cause the emit (from reading the function).
  "emitConditions": "Prose + the concrete predicate/branch that triggers the error.",

  // Short, ordered "how the repro was found" bullets — rendered as the report header summary.
  "summary": [
    "Open <surface>; the handler runs on delivered items but normal items pass the gate.",
    "Exercise the rare/edge-shaped entity that defeats the gate.",
    "Re-deliver that item on demand (e.g. a state toggle).",
    "The guard trips with a dump pinpointing the offending field — the error fires."
  ],

  // Call sites leading from UI-reachable entry points down to the emit site.
  "callers": [
    { "file": "packages/.../bar.tsx", "line": 0, "symbol": "...", "note": "why this matters" }
  ],

  // What was tried, in order (most recent last).
  "hypothesisHistory": [
    { "summary": "Open Calendar > Meet now > meeting chat rail",
      "result": "miss | hit",
      "steps": [ /* find-repro steps used for this attempt */ ],
      "note": "optional: marker confirmed path reached but condition not met, etc." }
  ],

  // The validated minimum repro.
  "minimumRepro": {
    "baseline": "How to reach the start state (e.g. 'fresh boot on Chat home').",
    "stepsFile": "repros/<slug>/steps.json",
    "expectations": [ { "name": "target", "pattern": "<regex>", "flags": "i" } ]
  },

  // Evidence captured during repro.
  "evidence": {
    "consoleLines": [ { "level": "error", "text": "...", "ts": "..." } ],
    "screenshots": [ "repros/<slug>/evidence/shot-1.png" ],
    // Markers must all be reverted unless critical to detection; this records what was added.
    // `id` is referenced by walkthrough[].markersObserved.markerRefs.
    // `codeContext` makes the report self-contained even after a marker is reverted.
    "markersUsed": [
      {
        "id": "guard",
        "file": "packages/.../foo.ts",
        "line": 0,
        "added": "console.error(\"[[FIND-REPRO:<slug>]] ...\")",
        "critical": true,
        "reverted": false,
        "note": "what this marker indicates",
        "codeContext": {
          "language": "ts",
          "startLine": 0,
          "snippet": "a few lines of surrounding code with the marker line included",
          "highlightLines": [ 0 ]   // optional: lines (absolute) to emphasize
        }
      }
    ]
  },

  // Human-facing per-step narrative — one entry per minimum-repro step the report shows.
  // This is what the report builder renders as the step cards; it is a projection of steps.json
  // plus captured screenshots/markers. Omit optional fields that don't apply to a step.
  "walkthrough": [
    {
      "stepIndex": 0,                       // index into steps.json (ties report to the input)
      "title": "Short heading for this step",
      "screenshot": "repros/<slug>/evidence/step1.png",   // the RAW screenshot
      // Data the builder needs to draw the red arrow. Captured live (rect centre + dpr + viewport).
      // Omit for result/no-interaction frames.
      "annotation": {
        "point": { "xCss": 0, "yCss": 0 },  // element centre in CSS pixels
        "dpr": 1.0,                          // window.devicePixelRatio at capture
        "viewport": { "w": 0, "h": 0 },      // window.innerWidth/innerHeight at capture
        "label": "click"                     // arrow label, e.g. "click" | "right-click"
      },
      "comment": "General descriptive text for this step.",
      "input": "The action performed, in human terms (rendered as the 'input:' block).",
      "critical": [ "Anything critical to the repro at this step (rendered as red callouts)." ],
      // What markers fired between this step and the next, and what they indicate.
      "markersObserved": {
        "summary": "Prose: which markers fired and what that means.",
        "lines": [ "the actual observed console line(s) for this step" ],
        "markerRefs": [ "guard" ]            // ids into evidence.markersUsed[]
      }
    }
  ],

  // Determinism check on the minimum repro.
  "validation": {
    "runs": 3,
    "passed": 3,
    "flaky": false,          // true for an intermittent/race repro that fires on some runs
    "hitRate": "3/3",        // observed match rate across runs (e.g. "3/10" for a race)
    "command": "node bin/run.js --steps repros/<slug>/steps.json --kill-existing"
  },

  // The environment the repro was captured in.
  "environment": {
    "shellExe": "Q:\\src\\teams-client-native-shell\\src\\_build\\x64\\TfwDebug\\ms-teams.exe",
    "startUrl": "https://local.teams.office.com/v2/?skipauthstrap=1",
    "appVersion": "optional bundledWebVersion if known"
  },

  // Everything the fix skill needs to act.
  "handoffForFix": {
    "suspectedFixLocations": [ "packages/.../foo.ts:NN (symbol)" ],
    "notes": "Root-cause guidance, e.g. prefer observable useOnChildViewEntityChange over the deprecated sync doesChildViewEntityMatch.",
    "howToValidateFix": "Replay repros/<slug>/steps.json (serve or batch). The detection expectation must NOT match after the fix."
  }
}
```

## `steps.json`

A standard find-repro steps document (same schema as `examples/` and `confirmed/`). It MUST
embed the detection expectation in `options.expectations` so any runner (serve or batch) can
assert the error fired:

```json
{
  "options": {
    "continueOnError": false,
    "expectations": [ { "name": "target", "pattern": "<regex>", "flags": "i" } ]
  },
  "steps": [ /* the minimum repro steps */ ]
}
```

## Status semantics

- `reproduced` — minimum repro found and validated. May be **deterministic** (expectation
  matched on every validation run) or **intermittent/race** (matched on some runs); for the
  latter set `validation.flaky: true` and record the `hitRate`. An intermittent-but-real repro
  is still `reproduced`.
- `partial` — the source/conditions/callers were identified and the code path was confirmed
  reached (e.g. via a marker), but the error condition was not triggered through the product
  within the attempt budget. Include the closest steps and what blocked it.
- `not-reproduced` — could not confirm the path was reached within the budget. Include the
  hypotheses tried and recommended next investigation.

## Human report (`<slug>.html` / `<slug>.linked.html`)

A human-readable report is generated from `repro.json` by the report builder:

```
python .github/skills/find-repro/scripts/build-report.py --repro repros/<slug>/repro.json
```

It requires **Pillow** (`pip install Pillow`) for screenshot annotation. It writes two files into
`repros/<slug>/`, named for the `<slug>` so shared files have unique names:

- `<slug>.html` — **self-contained**: screenshots (annotated) are base64-embedded, so it is a single
  file you can share/email.
- `<slug>.linked.html` — **lightweight**: references `evidence/*.png`; must travel with the folder.

The builder is a pure projection of the artifact — it adds no information of its own:

- **Header** ← `status`, `error` (message / detectionPattern / codeName / severity), `source`,
  `emitConditions` (root cause), `minimumRepro.baseline`, `validation` (hitRate), `environment`, and
  the `summary[]` bullets.
- **Per-step cards** ← `walkthrough[]`: the (raw) `screenshot` annotated with a red arrow at
  `annotation.point` labeled `annotation.label`; the `comment`; an `input:` block from `input`; red
  `critical[]` callouts; and a "markers observed" block from `markersObserved` (its `lines` plus the
  code of each referenced `evidence.markersUsed[]` entry via `codeContext`).

Because all rendered content (text, code context, observed lines, annotation geometry) lives in the
artifact, the report regenerates identically without re-running the repro, and remains correct even
after temporary markers are reverted in the product code. `annotation` geometry is stored in CSS
pixels + `dpr` + `viewport`, so the builder scales correctly to whatever resolution the screenshot
was captured at.

