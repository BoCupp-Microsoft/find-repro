# Repro handoff artifact schema

Each successful (or attempted) repro produces a directory:

```
repros/<slug>/
  repro.json     # the handoff artifact (schema below)
  steps.json     # runnable find-repro steps for the minimum repro
  evidence/      # screenshots and any captured console dumps
```

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
    "flags": "i"
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
    // Markers must all be reverted; this is a record of what was temporarily added.
    "markersUsed": [ { "file": "...", "line": 0, "added": "console.error(\"[[FIND-REPRO:<slug>]] ...\")", "reverted": true } ]
  },

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
