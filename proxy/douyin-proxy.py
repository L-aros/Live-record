#!/usr/bin/env python3
"""DouYin live start time proxy.
Deploy on Huawei Cloud (domestic IP) to bypass DouYin's cloud IP blocking.

Usage: python3 douyin-proxy.py
Env vars: PORT (default 3002), PROXY_PASSKEY (optional auth)
"""

import os, json, urllib.request, urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("PORT", 3002))
PASSKEY = os.environ.get("PROXY_PASSKEY", "")

DOUYIN_UA = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36"

def fetch_create_time(sec_user_id):
    params = urllib.parse.urlencode({
        "app_id": "1128", "live_id": "1", "verifyFp": "",
        "room_id": "2", "type_id": "0", "sec_user_id": sec_user_id,
    })
    url = f"https://webcast.amemv.com/webcast/room/reflow/info/?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": DOUYIN_UA})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    if data.get("status_code") != 0:
        return {"ok": False, "error": f"douyin {data.get('status_code')}"}
    room = (data.get("data") or {}).get("room")
    if not room or room.get("status") != 2:
        return {"ok": True, "living": False, "create_time": 0}
    return {"ok": True, "living": True, "create_time": room.get("create_time", 0)}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"ok": True})
            return
        if PASSKEY and self.headers.get("Authorization") != PASSKEY:
            self._respond(401, {"ok": False, "error": "unauthorized"})
            return
        if self.path.startswith("/create-time"):
            uid = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("uid", [""])[0]
            if not uid:
                self._respond(400, {"ok": False, "error": "missing uid"})
                return
            try:
                self._respond(200, fetch_create_time(uid))
            except Exception as e:
                self._respond(502, {"ok": False, "error": str(e)})
            return
        self._respond(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if PASSKEY and self.headers.get("Authorization") != PASSKEY:
            self._respond(401, {"ok": False, "error": "unauthorized"})
            return
        if self.path == "/create-times":
            body = json.loads(self.r.read(int(self.headers.get("Content-Length", 0))))
            uids = body.get("uids", [])
            results = []
            for uid in uids:
                try:
                    r = fetch_create_time(uid)
                    r["uid"] = uid
                    results.append(r)
                except Exception as e:
                    results.append({"uid": uid, "ok": False, "error": str(e)})
            self._respond(200, {"ok": True, "results": results})
            return
        self._respond(404, {"ok": False, "error": "not found"})

    def _respond(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # suppress access logs

if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"DouYin proxy listening on port {PORT}")
    server.serve_forever()
