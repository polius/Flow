"""Build step: allow the built page's inline scripts in the CSP by hash.

Usage: csp-hashes.py <built index.html> <nginx include to patch>

Replaces __INLINE_SCRIPT_HASHES__ in the include with one 'sha256-…'
source per inline <script> (no src) in the page, so the policy follows
whatever the frontend build emits without hand-maintained hashes.
"""

import base64
import hashlib
import sys
from html.parser import HTMLParser

PLACEHOLDER = "__INLINE_SCRIPT_HASHES__"


class InlineScripts(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.scripts: list[str] = []
        self._current: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "script" and not any(name == "src" for name, _ in attrs):
            self._current = []

    def handle_endtag(self, tag):
        if tag == "script" and self._current is not None:
            self.scripts.append("".join(self._current))
            self._current = None

    def handle_data(self, data):
        if self._current is not None:
            self._current.append(data)


def main(page: str, include: str) -> None:
    parser = InlineScripts()
    with open(page, encoding="utf-8") as f:
        parser.feed(f.read())
    sources = []
    for body in parser.scripts:
        digest = hashlib.sha256(body.encode("utf-8")).digest()
        sources.append(f"'sha256-{base64.b64encode(digest).decode()}'")

    with open(include, encoding="utf-8") as f:
        conf = f.read()
    if PLACEHOLDER not in conf:
        sys.exit(f"{include}: {PLACEHOLDER} not found")
    with open(include, "w", encoding="utf-8") as f:
        f.write(conf.replace(PLACEHOLDER, " ".join(sources)))
    print(f"CSP: {len(sources)} inline script(s) allowed by hash")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
