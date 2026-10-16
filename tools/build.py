#!/usr/bin/env python3
"""Build the single-file HF FAX web app.

    python tools/build.py

Reads src/index.template.html, splices src/hffax.js and src/app.js into the two
script slots and writes dist/index.html. Also cross-checks that every element id
the UI scripts look up actually exists in the finished document, so a typo in an
id cannot ship as a silently dead control.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "src" / "index.template.html"
ENGINE = ROOT / "src" / "hffax.js"
APP = ROOT / "src" / "app.js"
OUT = ROOT / "dist" / "index.html"

ENGINE_MARKER = "/*__HFFAX_ENGINE__*/"
APP_MARKER = "/*__HFFAX_APP__*/"


def fail(message: str) -> None:
    print("BUILD FAILED: " + message)
    sys.exit(1)


def ids_used_by_js(js: str) -> set[str]:
    """Element ids that the UI looks up, via $('id') / getElementById('id')."""
    ids = set(re.findall(r"\$\('([A-Za-z][\w-]*)'\)", js))
    ids |= set(re.findall(r"getElementById\('([A-Za-z][\w-]*)'\)", js))
    # Ids that are written to indirectly through the config form arrays.
    ids |= set(re.findall(r"'(crop[XYWH])'", js))
    return ids


def ids_in_html(html: str) -> set[str]:
    return set(re.findall(r'\bid="([^"]+)"', html))


def main() -> int:
    for path in (TEMPLATE, ENGINE, APP):
        if not path.exists():
            fail(f"missing {path}")

    template = TEMPLATE.read_text(encoding="utf-8")
    engine = ENGINE.read_text(encoding="utf-8")
    app = APP.read_text(encoding="utf-8")

    if ENGINE_MARKER not in template or APP_MARKER not in template:
        fail("template is missing a splice marker")

    for name, source in (("hffax.js", engine), ("app.js", app)):
        if "</script" in source.lower():
            fail(f"{name} contains a literal </script> — it would break the inline block")

    html = template.replace(ENGINE_MARKER, engine, 1).replace(APP_MARKER, app, 1)

    # Look for the exact marker comments, not for the marker *names*: app.js
    # mentions `__HFFAX_ENGINE__` in its own header comment on purpose.
    for leftover in ("/*__HFFAX_", "__HFFAX_ENGINE__*/", "__HFFAX_APP__*/"):
        if leftover in html:
            fail(f"a splice marker survived: {leftover}")

    # ---- id cross-check -------------------------------------------------
    html_ids = ids_in_html(html)
    js_ids = ids_used_by_js(app)
    missing = sorted(i for i in js_ids if i not in html_ids)
    if missing:
        fail("the UI looks up ids that the document does not define: " + ", ".join(missing))

    unused = sorted(i for i in html_ids if i not in js_ids and not i.startswith("toast"))
    # Informational only: a few ids are used by <label for=...> only.
    label_for = set(re.findall(r'<label[^>]*\bfor="([^"]+)"', html))
    unused = [i for i in unused if i not in label_for]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")

    kb = OUT.stat().st_size / 1024
    print(f"built {OUT.relative_to(ROOT)}  ({kb:.1f} KiB, {len(html.splitlines())} lines)")
    print(f"  engine {len(engine.splitlines())} lines + ui {len(app.splitlines())} lines")
    print(f"  ids referenced by the UI: {len(js_ids)}, all present")
    if unused:
        print("  note: ids not referenced by the UI: " + ", ".join(unused))
    return 0


if __name__ == "__main__":
    sys.exit(main())
