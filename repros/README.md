# Repros

Output directory for the `find-repro` skill (see `..\.github\skills\find-repro\SKILL.md`).

Each repro lives in `repros/<slug>/` with:

- `repro.json` — the handoff artifact consumed by a downstream fix skill (schema: `SCHEMA.md`).
- `steps.json` — the runnable minimum repro (replayable via serve or `node bin/run.js`).
- `evidence/` — screenshots and captured console.

See `SCHEMA.md` for the full artifact specification, and `end-entity-chatthread/` for a
worked example.
