// DouYin live start time proxy
// Deploy alongside biliLive-tools on EC2.
// CF Worker calls this to get real create_time from DouYin mobile API.
//
// Usage: node douyin-proxy.js
// Listens on port 3002 by default (configurable via PORT env var)

import http from "http";

const PORT = process.env.PORT || 3002;
const PASSKEY = process.env.PROXY_PASSKEY || "";

async function fetchDouyinCreateTime(secUserId) {
  const params = new URLSearchParams({
    app_id: "1128",
    live_id: "1",
    verifyFp: "",
    room_id: "2",
    type_id: "0",
    sec_user_id: secUserId,
  });
  const url = "https://webcast.amemv.com/webcast/room/reflow/info/?" + params.toString();
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36" },
  });
  if (!res.ok) return { ok: false, error: "upstream " + res.status };
  const data = await res.json();
  if (data.status_code !== 0) return { ok: false, error: "douyin " + data.status_code };
  const room = data?.data?.room;
  if (!room || room.status !== 2) return { ok: true, living: false, create_time: 0 };
  return { ok: true, living: true, create_time: room.create_time || 0 };
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  // Auth check
  if (PASSKEY && req.headers.authorization !== PASSKEY) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"ok":false,"error":"unauthorized"}');
    return;
  }

  // GET /create-time?uid=xxx
  if (req.method === "GET" && req.url.startsWith("/create-time")) {
    const urlObj = new URL(req.url, "http://localhost");
    const uid = urlObj.searchParams.get("uid") || "";
    if (!uid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"ok":false,"error":"missing uid"}');
      return;
    }
    try {
      const result = await fetchDouyinCreateTime(uid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // GET /create-times — batch: POST body = {"uids":["uid1","uid2"]}
  if (req.method === "POST" && req.url === "/create-times") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { uids } = JSON.parse(body);
      const results = await Promise.all(
        (uids || []).map(async (uid) => {
          try {
            const r = await fetchDouyinCreateTime(uid);
            return { uid, ...r };
          } catch (e) {
            return { uid, ok: false, error: String(e) };
          }
        })
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, results }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end('{"ok":false,"error":"not found"}');
});

server.listen(PORT, () => {
  console.log("DouYin proxy listening on port " + PORT);
});
