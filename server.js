import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import http from "http";
import https from "https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3003;

// biliLive-tools API config — set API_KEY via environment variable or .env file
const API_BASE = process.env.API_BASE || "http://127.0.0.1:3001";
const API_KEY = process.env.API_KEY || "";

// Proxy helper
async function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    http.get(url.toString(), { headers: { Authorization: API_KEY } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    }).on("error", reject);
  });
}

// API: dashboard data
app.get("/api/status", async (req, res) => {
  try {
    const [recorders, version] = await Promise.all([
      apiRequest("/api/recorder/list?pageSize=100"),
      apiRequest("/api/common/version"),
    ]);

    const list = recorders?.payload?.data || [];

    const recording = list.filter(r => r.state === "recording");
    const living = list.filter(r => r.liveInfo?.living === true);

    res.json({
      ok: true,
      version: version?.payload?.data || version?.data || version,
      total: list.length,
      recording: recording.length,
      living: living.length,
      rooms: list.map(r => ({
        id: r.id,
        name: r.remarks || r.liveInfo?.owner || "",
        roomId: r.channelId,
        platform: r.providerId,
        living: r.liveInfo?.living || false,
        recording: r.state === "recording",
        title: r.liveInfo?.title || "",
        autoCheck: !r.disableAutoCheck,
        avatar: r.liveInfo?.avatar || r.extra?.avatar || "",
        progress: r.recordHandle?.progress?.time || "",
      })),
      timestamp: Date.now(),
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});


// Image proxy to bypass referer checks
app.get("/api/avatar", (req, res) => {
  const url = req.query.url;
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return res.status(400).end();
  }
  const client = url.startsWith("https") ? https : http;
  client.get(url, { headers: { Referer: "" } }, (proxyRes) => {
    res.set("Content-Type", proxyRes.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    proxyRes.pipe(res);
  }).on("error", () => res.status(502).end());
});

// Serve static frontend
app.use(express.static(join(__dirname, "public")));

app.listen(PORT, "127.0.0.1", () => {
  console.log("Dashboard running at http://127.0.0.1:" + PORT);
});
