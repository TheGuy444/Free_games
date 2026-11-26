"""Stdlib HTTP server: serves the dashboard and the JSON API.

No dependencies, no build step.  One process, threaded, one save open at a time.
"""
from __future__ import annotations

import json
import mimetypes
import os
import socket
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import api

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
MAX_BODY = 1 << 20


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "HollywoodTycoon/0.1"

    # ------------------------------------------------------------------ util
    def _send(self, code: int, body: bytes, ctype: str, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, default=str).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _static(self, path: str):
        if path in ("/", ""):
            path = "/index.html"
        full = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
        if not full.startswith(WEB) or not os.path.isfile(full):
            full = os.path.join(WEB, "index.html")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        with open(full, "rb") as fh:
            self._send(200, fh.read(), ctype)

    def _params(self, query: dict, body: dict) -> dict:
        out = {}
        for k, v in query.items():
            out[k] = v[-1] if isinstance(v, list) else v
        out.update(body or {})
        return out

    # ------------------------------------------------------------------ verbs
    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        if u.path.startswith("/api/"):
            try:
                self._json(api.handle("GET", u.path, self._params(
                    parse_qs(u.query, keep_blank_values=True), {})))
            except Exception as exc:
                traceback.print_exc()
                self._json(dict(ok=False, error=f"{type(exc).__name__}: {exc}"), 500)
            return
        self._static(u.path)

    def do_POST(self):  # noqa: N802
        u = urlparse(self.path)
        length = min(MAX_BODY, int(self.headers.get("Content-Length") or 0))
        raw = self.rfile.read(length) if length else b""
        body = {}
        if raw:
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                body = {k: v[-1] for k, v in parse_qs(raw.decode("utf-8", "ignore"),
                                                      keep_blank_values=True).items()}
        if not u.path.startswith("/api/"):
            self._json(dict(ok=False, error="post an api path"), 404)
            return
        try:
            self._json(api.handle("POST", u.path, self._params(
                parse_qs(u.query, keep_blank_values=True), body)))
        except Exception as exc:
            traceback.print_exc()
            self._json(dict(ok=False, error=f"{type(exc).__name__}: {exc}"), 500)

    def log_message(self, fmt, *args):
        if os.environ.get("HT_QUIET") != "1":
            import sys
            sys.stderr.write("  %s\n" % (fmt % args))


def LAN_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def serve(host: str = "127.0.0.1", port: int = 8000, open_game: str | None = None,
          new_game: bool = False, quiet: bool = False):
    if quiet:
        os.environ["HT_QUIET"] = "1"
    os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), "saves"), exist_ok=True)
    if open_game:
        res = api.handle("POST", "/api/load", dict(slug=open_game))
        if not res.get("ok"):
            print(f"could not load {open_game}: {res.get('error')}")
    elif new_game:
        res = api.handle("POST", "/api/new_game", dict(name="Meridian Pictures",
                                                       start_year=1928, preset="studio"))
        print("new game:", res.get("slug"))
    httpd = ThreadingHTTPServer((host, port), Handler)
    ip = LAN_ip()
    print()
    print("  HOLLYWOOD TYCOON")
    print(f"  play at   http://{'localhost' if host in ('0.0.0.0', '') else host}:{port}")
    if host == "0.0.0.0":
        print(f"  on your LAN  http://{ip}:{port}")
    print("  ctrl-c to stop (the studio saves itself as it goes)")
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down...")
        if api.WORLD:
            api.WORLD.flush()
            api.WORLD.db.commit()
            api.WORLD.db.close()
        httpd.server_close()
