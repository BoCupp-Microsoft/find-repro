#!/usr/bin/env python3
"""Build a human-facing HTML report from a find-repro handoff artifact.

Reads `repro.json` (schema: repros/SCHEMA.md) and renders the repro as an annotated,
step-by-step HTML report. The report is a pure projection of the artifact: every piece of
displayed content (text, code context, observed console lines, screenshot-annotation geometry)
comes from `repro.json` or files it references under `evidence/`.

Two outputs are written next to `repro.json`, named for the repro `<slug>` (the repro.json's
parent directory) so shared files have unique names instead of all being "report.*":
  - <slug>.html         self-contained (screenshots base64-embedded) — a single shareable file.
  - <slug>.linked.html  lightweight — references evidence/*.png (must travel with the folder).

Red "click" arrows are drawn onto the raw screenshots from each walkthrough step's `annotation`
(element centre in CSS px + dpr + viewport + label), saved as evidence/<name>-annotated.png.

Dependency: Pillow  (pip install Pillow). Everything else is Python stdlib.

Usage:
  python build-report.py --repro repros/<slug>/repro.json
"""
import argparse
import base64
import html as _html
import json
import math
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("error: Pillow is required. Install it with:  pip install Pillow")


# ----------------------------------------------------------------------------- annotation

def _font(size):
    for name in ("arialbd.ttf", "segoeuib.ttf", "DejaVuSans-Bold.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _arrow_offset(x, y, w, h):
    """Pick an arrow tail offset (image px) that keeps arrow+label on-screen and off the target."""
    dx = +0.20 * w if x < w / 2 else -0.20 * w
    dy = +0.16 * h if y < h / 2 else -0.16 * h
    return dx, dy


def annotate(raw_path: Path, ann: dict, out_path: Path):
    """Draw a red arrow + label on a copy of `raw_path` per `annotation`; save to out_path."""
    im = Image.open(raw_path).convert("RGB")
    iw, ih = im.size
    vp = ann.get("viewport") or {}
    vw = float(vp.get("w") or 0) or iw
    vh = float(vp.get("h") or 0) or ih
    # CSS px -> image px. Prefer the true image/viewport ratio; fall back to dpr.
    sx = iw / vw if vw else float(ann.get("dpr") or 1)
    sy = ih / vh if vh else float(ann.get("dpr") or 1)
    pt = ann.get("point") or {}
    tx = float(pt.get("xCss", 0)) * sx
    ty = float(pt.get("yCss", 0)) * sy
    off = ann.get("arrowFromCss")
    if off:
        sxp = float(off.get("dxCss", 0)) * sx
        syp = float(off.get("dyCss", 0)) * sy
    else:
        sxp, syp = _arrow_offset(tx, ty, iw, ih)
    stx, sty = tx + sxp, ty + syp

    d = ImageDraw.Draw(im)
    red = (220, 0, 0)
    width = max(5, round(iw / 280))
    d.line([(stx, sty), (tx, ty)], fill=red, width=width)
    # arrowhead
    ang = math.atan2(ty - sty, tx - stx)
    L = max(18, round(iw / 58))
    spread = math.radians(26)
    d.polygon([
        (tx, ty),
        (tx - L * math.cos(ang + spread), ty - L * math.sin(ang + spread)),
        (tx - L * math.cos(ang - spread), ty - L * math.sin(ang - spread)),
    ], fill=red)
    # label box near the tail
    label = str(ann.get("label", "click"))
    f = _font(max(22, round(iw / 50)))
    bb = d.textbbox((0, 0), label, font=f)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    pad = max(6, round(iw / 240))
    lx = min(max(4, stx - tw / 2), iw - tw - 2 * pad - 4)
    ly = min(max(4, sty - th / 2), ih - th - 2 * pad - 4)
    d.rectangle([lx, ly, lx + tw + 2 * pad, ly + th + 2 * pad],
                fill=(255, 255, 255), outline=red, width=max(2, width // 2))
    d.text((lx + pad, ly + pad - bb[1]), label, fill=red, font=f)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_path)


# ----------------------------------------------------------------------------- html helpers

def esc(s):
    return _html.escape("" if s is None else str(s))


def b64(path: Path):
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


CSS = """
*{box-sizing:border-box}
body{margin:0;background:#0f1117;color:#e6e8ee;font:16px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:32px 22px 80px}
h1{font-size:30px;margin:0 0 4px}
.sub{color:#9aa3b2;margin:0 0 26px}
.card{background:#171a23;border:1px solid #262b38;border-radius:14px;padding:22px 24px;margin:0 0 26px}
.badge{display:inline-block;padding:3px 12px;border-radius:999px;font-weight:700;font-size:13px;letter-spacing:.3px}
.ok{background:#10331f;color:#4ade80;border:1px solid #1c5132}
.warn{background:#3a2a0f;color:#fbbf24;border:1px solid #5b4318}
.bad{background:#3a1413;color:#f87171;border:1px solid #5b201d}
.meta{width:100%;border-collapse:collapse;margin-top:10px}
.meta td{padding:7px 10px;border-top:1px solid #262b38;vertical-align:top}
.meta td.k{color:#9aa3b2;white-space:nowrap;width:190px}
code{background:#0c0e14;border:1px solid #262b38;border-radius:5px;padding:1px 6px;color:#ffd479;font-family:Consolas,Menlo,monospace;font-size:13px}
.summary{counter-reset:s;margin:10px 0 0;padding:0;list-style:none}
.summary li{counter-increment:s;position:relative;padding:6px 0 6px 34px;border-top:1px solid #262b38}
.summary li:before{content:counter(s);position:absolute;left:0;top:6px;width:23px;height:23px;border-radius:50%;background:#2b3242;color:#cdd3df;font-size:13px;font-weight:700;text-align:center;line-height:23px}
.step{background:#171a23;border:1px solid #262b38;border-radius:14px;overflow:hidden;margin:0 0 30px}
.step h2{margin:0;padding:16px 22px;background:#1d2130;border-bottom:1px solid #262b38;font-size:19px}
.step h2 .num{display:inline-block;width:30px;height:30px;line-height:30px;text-align:center;background:#3b82f6;color:#fff;border-radius:8px;font-size:15px;margin-right:12px}
.step .body{padding:20px 22px}
.shot{width:100%;border-radius:10px;display:block;margin:4px 0 6px;border:1px solid #2c3340}
.arrow-note{color:#9aa3b2;font-size:13px;margin:6px 0 14px}
.input{background:#0c1830;border:1px solid #1e3a66;border-left:4px solid #3b82f6;border-radius:8px;padding:12px 14px;margin:8px 0}
.input .tag{color:#60a5fa;font-weight:800;margin-right:6px}
.crit{background:#2a1411;border:1px solid #5b2018;border-left:4px solid #ef4444;border-radius:8px;padding:12px 14px;margin:8px 0}
.crit .tag{color:#f87171;font-weight:800;text-transform:uppercase;font-size:12px;letter-spacing:.6px;display:block;margin-bottom:3px}
.markers{background:#10231b;border:1px solid #1d4733;border-left:4px solid #22c55e;border-radius:8px;padding:12px 14px;margin:8px 0}
.markers .tag{color:#4ade80;font-weight:800;text-transform:uppercase;font-size:12px;letter-spacing:.6px;display:block;margin-bottom:4px}
pre{background:#0a0c12;border:1px solid #262b38;border-radius:8px;padding:14px 16px;overflow-x:auto;font:12.5px/1.5 Consolas,Menlo,monospace;color:#cbd5e1;margin:8px 0;white-space:pre}
pre.observed{color:#fca5a5;background:#1a0e0e;border-color:#3a1c1c}
.codecap{font-size:13px;color:#9aa3b2;margin:14px 0 2px}
"""

_BADGE = {"reproduced": ("ok", "\u2714 REPRODUCED"),
          "partial": ("warn", "\u25d1 PARTIAL"),
          "not-reproduced": ("bad", "\u2715 NOT REPRODUCED")}


def header_html(data):
    status = (data.get("status") or "").lower()
    cls, txt = _BADGE.get(status, ("warn", status.upper() or "UNKNOWN"))
    val = data.get("validation") or {}
    if val.get("hitRate"):
        txt += f" &mdash; {esc(val.get('hitRate'))}"
        if val.get("flaky"):
            txt += " (flaky)"
    err = data.get("error") or {}
    src = data.get("source") or {}
    env = data.get("environment") or {}

    rows = []

    def row(k, v):
        if v:
            rows.append(f'<tr><td class="k">{esc(k)}</td><td>{v}</td></tr>')

    if err.get("codeName"):
        row("Error code", f'<code>{esc(err.get("codeName"))}</code>')
    row("Error", esc(err.get("message")))
    if err.get("detectionPattern"):
        row("Detection pattern", f'<code>{esc(err.get("detectionPattern"))}</code>')
    if src.get("file"):
        loc = f'<code>{esc(src.get("file"))}{":" + str(src.get("line")) if src.get("line") else ""}</code>'
        if src.get("symbol"):
            loc = f'<code>{esc(src.get("symbol"))}</code><br>{loc}'
        row("Source", loc)
    row("Severity / surface", esc(err.get("severity")))
    row("Root cause", esc(data.get("emitConditions")))
    mr = data.get("minimumRepro") or {}
    row("Baseline", esc(mr.get("baseline")))
    if env:
        e = " &middot; ".join(filter(None, [
            f'<code>{esc(env.get("startUrl"))}</code>' if env.get("startUrl") else "",
            esc(env.get("appVersion")) if env.get("appVersion") else "",
        ]))
        row("Environment", e)

    parts = [f'<div class="card"><span class="badge {cls}">{txt}</span>',
             f'<table class="meta">{"".join(rows)}</table></div>']

    summary = data.get("summary") or []
    if summary:
        items = "".join(f"<li>{esc(s)}</li>" for s in summary)
        parts.append('<div class="card"><strong>How the repro was found &mdash; '
                     'summary of the steps that follow</strong>'
                     f'<ol class="summary">{items}</ol></div>')
    return "".join(parts)


def marker_block_html(refs, markers_by_id):
    out = []
    for rid in refs or []:
        m = markers_by_id.get(rid)
        if not m:
            continue
        cc = m.get("codeContext") or {}
        snippet = cc.get("snippet")
        cap_bits = [b for b in [m.get("note"), m.get("file")] if b]
        cap = " &mdash; ".join(esc(b) for b in cap_bits)
        if cap:
            out.append(f'<div class="codecap">{cap}</div>')
        if snippet:
            out.append(f"<pre>{esc(snippet)}</pre>")
    return "".join(out)


def step_html(step, idx, markers_by_id, img_src):
    h = ['<div class="step">',
         f'<h2><span class="num">{idx}</span>{esc(step.get("title"))}</h2>',
         '<div class="body">']
    if img_src:
        h.append(f'<img class="shot" src="{img_src}" alt="step {idx}">')
        ann = step.get("annotation")
        if ann:
            h.append(f'<p class="arrow-note">\u25b2 The red arrow labeled '
                     f'\u201c{esc(ann.get("label", "click"))}\u201d marks where to interact.</p>')
    if step.get("comment"):
        h.append(f'<p>{esc(step.get("comment"))}</p>')
    if step.get("input"):
        h.append(f'<div class="input"><span class="tag">input:</span>{esc(step.get("input"))}</div>')
    for c in step.get("critical") or []:
        h.append(f'<div class="crit"><span class="tag">\u26a0 critical</span>{esc(c)}</div>')
    mo = step.get("markersObserved")
    if mo:
        h.append('<div class="markers"><span class="tag">Markers observed</span>')
        if mo.get("summary"):
            h.append(f'<p style="margin:0 0 6px">{esc(mo.get("summary"))}</p>')
        for line in mo.get("lines") or []:
            h.append(f'<pre class="observed">{esc(line)}</pre>')
        h.append('</div>')
        h.append(marker_block_html(mo.get("markerRefs"), markers_by_id))
    h.append('</div></div>')
    return "".join(h)


def document(data, steps_html):
    title = (data.get("error") or {}).get("codeName") or (data.get("error") or {}).get("message") or "find-repro"
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>Repro Report \u2014 {esc(title)}</title><style>{CSS}</style></head>'
            f'<body><div class="wrap">'
            f'<h1>Repro Report &mdash; <code>{esc(title)}</code></h1>'
            f'<p class="sub">find-repro handoff &middot; generated from repro.json</p>'
            f'{header_html(data)}{steps_html}'
            f'<p class="sub" style="margin-top:30px">Generated by the find-repro report builder. '
            f'Markers are temporary <code>console.error</code> probes co-located with the real '
            f'(often sub-console-level) emit; their code is captured in the artifact.</p>'
            f'</div></body></html>')


# ----------------------------------------------------------------------------- main

def resolve(base: Path, p):
    """Resolve an artifact-relative or repo-relative path to a real file."""
    if not p:
        return None
    cand = Path(p)
    for root in (base, base.parent, base.parent.parent, Path.cwd()):
        q = (root / cand) if not cand.is_absolute() else cand
        if q.exists():
            return q
    return base / cand  # best effort


def main():
    ap = argparse.ArgumentParser(description="Build an HTML report from a find-repro artifact.")
    ap.add_argument("--repro", required=True, help="path to repros/<slug>/repro.json")
    ap.add_argument("--out-dir", help="output directory (default: alongside repro.json)")
    args = ap.parse_args()

    repro_path = Path(args.repro).resolve()
    if not repro_path.exists():
        sys.exit(f"error: not found: {repro_path}")
    data = json.loads(repro_path.read_text(encoding="utf-8"))
    slug_dir = repro_path.parent
    out_dir = Path(args.out_dir).resolve() if args.out_dir else slug_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    markers_by_id = {m.get("id"): m for m in (data.get("evidence") or {}).get("markersUsed", []) if m.get("id")}
    walkthrough = data.get("walkthrough") or []

    # Produce annotated images and remember, per step, the on-disk image (annotated or raw).
    step_images = []  # (Path or None)
    for i, step in enumerate(walkthrough):
        raw_rel = step.get("screenshot")
        raw = resolve(slug_dir, raw_rel)
        if not raw or not raw.exists():
            step_images.append(None)
            continue
        ann = step.get("annotation")
        if ann:
            out_img = raw.with_name(raw.stem + "-annotated.png")
            try:
                annotate(raw, ann, out_img)
            except Exception as e:  # fall back to raw on any drawing error
                print(f"  warn: annotation failed for step {i}: {e}", file=sys.stderr)
                out_img = raw
        else:
            out_img = raw
        step_images.append(out_img)

    # Build the two variants. Name them for the repro slug (the repro.json's parent
    # directory) so shared files have unique names instead of all being "report.*".
    slug = slug_dir.name
    for embed, name in ((True, f"{slug}.html"), (False, f"{slug}.linked.html")):
        cards = []
        for i, step in enumerate(walkthrough):
            img = step_images[i]
            if img is None:
                src = None
            elif embed:
                src = b64(img)
            else:
                try:
                    src = img.relative_to(out_dir).as_posix()
                except ValueError:
                    src = img.as_posix()
            cards.append(step_html(step, i + 1, markers_by_id, src))
        (out_dir / name).write_text(document(data, "".join(cards)), encoding="utf-8")
        print(f"wrote {out_dir / name}")


if __name__ == "__main__":
    main()
