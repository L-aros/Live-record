// Cloudflare Worker for live recorder status dashboard.
// Backed by biliLive-tools API. Inlines initial data into the HTML for instant first paint.

const PLATFORMS = {
  Bilibili: { label: "B站", cls: "bili", color: "#4A90E2", url: "https://live.bilibili.com/" },
  DouYu:    { label: "斗鱼", cls: "douyu", color: "#FF6B35", url: "https://www.douyu.com/" },
  HuYa:     { label: "虎牙", cls: "huya", color: "#FFB020", url: "https://www.huya.com/" },
  DouYin:   { label: "抖音", cls: "douyin", color: "#9B7FFF", url: "https://live.douyin.com/" },
};

const CST_OFFSET_MS = 8 * 3600 * 1000;
// Rough bitrate guess used for "filesize so far" in active recordings (no API for live size).
const APPROX_BYTES_PER_SECOND = 2.5 * 1024 * 1024; // ~2.5 MB/s, a typical 1080p/HEVC live stream

async function apiGet(env, path, params) {
  const url = new URL(path, env.API_BASE);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    headers: { Authorization: env.PASSKEY || "" },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}

// Fetch real live start time from DouYin via proxy server.
// DouYin's mobile API blocks Cloudflare IPs, so we proxy through an EC2 server.
// Returns epoch ms of when the broadcast actually started, or 0 on failure.
const DOUYIN_PROXY_URL = "https://live.neoclaw.asia/douyin-proxy";

async function fetchDouyinRealStartTime(env, uid) {
  if (!uid) return 0;
  try {
    const url = DOUYIN_PROXY_URL + "/create-time?uid=" + encodeURIComponent(uid);
    const r = await fetch(url, {
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!r.ok) return 0;
    const j = await r.json();
    if (!j.ok || !j.living) return 0;
    return (j.create_time || 0) * 1000; // seconds → ms
  } catch {
    return 0;
  }
}

async function apiPost(env, path, body) {
  const url = new URL(path, env.API_BASE);
  const r = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: env.PASSKEY || "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}

function todayStartCST(now) {
  return Math.floor((now + CST_OFFSET_MS) / 86400000) * 86400000 - CST_OFFSET_MS;
}

function dowLabelCST(ts) {
  const d = new Date(ts + CST_OFFSET_MS);
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getUTCDay()];
}

async function getStatusData(env) {
  const now = Date.now();
  try {
    const recorders = await apiGet(env, "/api/recorder/list", { pageSize: 100 });
    const list = (recorders && recorders.payload && recorders.payload.data) || [];

    // For rooms with disableAutoCheck=true, the cached liveInfo on /recorder/list is stale.
    // POST /recorder/manager/liveInfo asks biliLive-tools to actively query upstream — this
    // makes "directly query live state" independent of the recording auto-check setting.
    //
    // Caveat: this endpoint sets liveStartTime to the *call time*, not the actual broadcast
    // start. We must NOT overwrite the (correct) liveStartTime from /recorder/list — though
    // for autoCheck=false rooms that field is empty anyway. We merge field-by-field to keep
    // any existing real values intact.
    const staleIds = list.filter((r) => r.disableAutoCheck === true).map((r) => r.id);
    if (staleIds.length > 0) {
      try {
        const fresh = await apiPost(env, "/api/recorder/manager/liveInfo", { ids: staleIds });
        const freshArr = (fresh && fresh.payload) || [];
        const byChannel = new Map();
        for (const item of freshArr) {
          if (item && item.channelId) byChannel.set(String(item.channelId), item);
        }
        for (const r of list) {
          if (r.disableAutoCheck !== true) continue;
          const fresh = byChannel.get(String(r.channelId));
          if (!fresh) continue;
          // Merge: keep r.liveInfo as a base, overlay fresh fields from live query.
          const base = r.liveInfo || {};
          r.liveInfo = Object.assign({}, base, fresh);
          // /manager/liveInfo returns liveStartTime = call time (not actual broadcast start).
          // Preserve the original value from /recorder/list if available (it's authoritative).
          // If empty (typical for disableAutoCheck rooms), keep fresh.liveStartTime as an
          // approximation — the frontend's stableLiveStart will correct it once history data
          // arrives with the real live_start_time.
          if (base.liveStartTime) r.liveInfo.liveStartTime = base.liveStartTime;
        }
      } catch (e) {
        // Fail-soft: leave stale liveInfo as-is. Front-end still works.
      }
    }

    // For live DouYin rooms, fetch real liveStartTime from DouYin's mobile API.
    // biliLive-tools returns call time as liveStartTime; DouYin API returns actual create_time.
    // Store proxy results keyed by liveId so we can override history's live_start_time later.
    const douyinRealStartByLiveId = new Map();
    const douyinLiveRooms = list.filter((r) => {
      const li = r.liveInfo;
      return li && li.living && r.providerId === "DouYin" && li.uid;
    });
    if (douyinLiveRooms.length > 0) {
      const realStarts = await Promise.all(
        douyinLiveRooms.map((r) =>
          fetchDouyinRealStartTime(env, r.liveInfo.uid)
            .then((ts) => ({ id: r.id, ts }))
            .catch(() => ({ id: r.id, ts: 0 }))
        )
      );
      const startMap = new Map(realStarts.map((s) => [s.id, s.ts]));
      for (const r of list) {
        const ts = startMap.get(r.id);
        if (ts > 0) {
          r.liveInfo.liveStartTime = new Date(ts).toISOString();
          // Map by liveId so sessionLiveStart computation can use it
          const liveId = r.liveInfo && r.liveInfo.liveId;
          if (liveId) douyinRealStartByLiveId.set(String(liveId), ts);
        }
      }
    }

    const todayStart = todayStartCST(now);
    const weekStart = todayStart - 6 * 86400000; // includes today, 7 buckets

    // Fetch each room's history in parallel. Failures degrade silently.
    const histResults = await Promise.all(list.map((r) =>
      apiGet(env, "/api/record-history/list", {
        pageSize: 50,
        page: 1,
        room_id: r.channelId,
        platform: r.providerId,
      })
        .then((j) => ({ rid: r.id, items: (j && j.data) || [] }))
        .catch(() => ({ rid: r.id, items: [] }))
    ));
    const historyMap = new Map(histResults.map((h) => [h.rid, h.items]));

    // Aggregates
    let todayDuration = 0;
    let todayDanmu = 0;
    let todayInteract = 0;
    const weekBuckets = new Array(7).fill(0); // seconds per CST day, idx 0 = 6 days ago, 6 = today

    for (const items of historyMap.values()) {
      for (const h of items) {
        const startMs = h.record_start_time;
        if (!startMs) continue;
        const endMs = h.record_end_time || now;
        const dur = Math.max(0, (endMs - startMs) / 1000);
        if (startMs >= todayStart) {
          todayDuration += dur;
          todayDanmu += h.danma_num || 0;
          todayInteract += h.interact_num || 0;
        }
        if (startMs >= weekStart) {
          const idx = Math.floor((startMs - weekStart) / 86400000);
          if (idx >= 0 && idx < 7) weekBuckets[idx] += dur;
        }
      }
    }

    // Per-room cards
    const rooms = list.map((r) => {
      const plat = PLATFORMS[r.providerId] || { label: r.providerId, cls: "default", color: "#7A8899", url: "" };
      const living = !!(r.liveInfo && r.liveInfo.living);
      const recording = r.state === "recording";
      const status = recording ? "rec" : living ? "live" : "idle";
      const liveStatus = living ? "live" : "idle"; // fan-facing: ignores recording detail
      const items = historyMap.get(r.id) || [];
      const ongoing = items.find((h) => h.record_start_time && !h.record_end_time);
      const lastFinished = items.find((h) => h.record_end_time);

      // Aggregate the CURRENT live session across all its segments.
      // biliLive-tools splits a live into 30-minute segments; finished segments carry
      // danma_num/interact_num, the ongoing one is null until it completes.
      // Sum across same live_id to get "本场至今" totals; use the earliest live_start_time
      // as the unsplit "首次开播时间".
      const currentLiveId = (ongoing && ongoing.live_id)
        || (living && r.liveInfo && r.liveInfo.liveId)
        || null;
      let sessionDanmu = 0;
      let sessionInteract = 0;
      let sessionSeconds = 0;
      let sessionLiveStart = 0;
      // DouYin proxy provides real create_time; prefer it over history's live_start_time
      // (which biliLive-tools sets to the call time, not the actual broadcast start).
      if (currentLiveId && douyinRealStartByLiveId.has(String(currentLiveId))) {
        sessionLiveStart = douyinRealStartByLiveId.get(String(currentLiveId));
      }
      if (currentLiveId) {
        for (const h of items) {
          if (h.live_id !== currentLiveId) continue;
          sessionDanmu += h.danma_num || 0;
          sessionInteract += h.interact_num || 0;
          if (h.record_start_time) {
            const end = h.record_end_time || now;
            sessionSeconds += Math.max(0, (end - h.record_start_time) / 1000);
          }
          // Only use history's live_start_time if we don't have a DouYin proxy value
          if (!sessionLiveStart && h.live_start_time) {
            sessionLiveStart = h.live_start_time;
          }
        }
      }
      // Fallbacks if history hasn't caught up yet
      if (!sessionLiveStart && living && r.liveInfo && r.liveInfo.liveStartTime) {
        sessionLiveStart = new Date(r.liveInfo.liveStartTime).getTime();
      }
      // If living without any recording yet, use elapsed live time so density can be computed
      if (sessionSeconds === 0 && sessionLiveStart && living) {
        sessionSeconds = Math.max(0, (now - sessionLiveStart) / 1000);
      }
      const sessionDensity = sessionSeconds > 0 ? sessionDanmu / sessionSeconds : 0;

      let recordStartTimestamp = 0;
      if (ongoing && ongoing.record_start_time) recordStartTimestamp = ongoing.record_start_time;
      else if (recording && r.liveInfo && r.liveInfo.recordStartTime) {
        recordStartTimestamp = new Date(r.liveInfo.recordStartTime).getTime();
      }

      // today + 7-day aggregate per room
      let roomTodayDuration = 0;
      let roomTodayDanmu = 0;
      let roomWeekSeconds = 0;
      let roomWeekDanmu = 0;
      let roomWeekDensitySumWeighted = 0;
      let roomWeekDensityWeight = 0;
      const roomWeekDaily = new Array(7).fill(0); // seconds per CST day
      const sessionDays = new Set();
      let sessionsCount = 0;
      for (const h of items) {
        const startMs = h.record_start_time;
        if (!startMs) continue;
        const endMs = h.record_end_time || now;
        const dur = Math.max(0, (endMs - startMs) / 1000);
        if (startMs >= todayStart) {
          roomTodayDuration += dur;
          roomTodayDanmu += h.danma_num || 0;
        }
        if (startMs >= weekStart) {
          const idx = Math.floor((startMs - weekStart) / 86400000);
          if (idx >= 0 && idx < 7) roomWeekDaily[idx] += dur;
          roomWeekSeconds += dur;
          roomWeekDanmu += h.danma_num || 0;
          if (h.danma_density && dur > 0) {
            roomWeekDensitySumWeighted += h.danma_density * dur;
            roomWeekDensityWeight += dur;
          }
          sessionsCount++;
          // dedupe sessions by CST day for "开播次数" — same day multi-segments count once
          const dayKey = Math.floor((startMs + CST_OFFSET_MS) / 86400000);
          sessionDays.add(dayKey);
        }
      }
      const avgDensity = roomWeekDensityWeight > 0 ? roomWeekDensitySumWeighted / roomWeekDensityWeight : 0;

      return {
        id: r.id,
        name: r.remarks || (r.liveInfo && r.liveInfo.owner) || "",
        roomId: r.channelId,
        platform: r.providerId,
        platformLabel: plat.label,
        platformClass: plat.cls,
        url: plat.url + (r.channelId || ""),
        avatar: (r.liveInfo && r.liveInfo.avatar) || (r.extra && r.extra.avatar) || "",
        cover: (r.liveInfo && r.liveInfo.cover) || "",
        title: (r.liveInfo && r.liveInfo.title) || "",
        area: (r.liveInfo && r.liveInfo.area) || "",
        status,
        liveStatus,
        recording,
        living,
        autoCheck: !r.disableAutoCheck,
        recordStartTimestamp,
        liveStartTimestamp: sessionLiveStart,
        liveId: currentLiveId || "",
        currentDanmu: sessionDanmu,
        currentDanmaDensity: +sessionDensity.toFixed(3),
        currentInteract: sessionInteract,
        todayDuration: Math.floor(roomTodayDuration),
        todayDanmu: roomTodayDanmu,
        weekStats: {
          sessions: sessionDays.size,        // distinct days streamed in last 7 days
          segments: sessionsCount,           // total recording segments
          totalSeconds: Math.floor(roomWeekSeconds),
          totalDanmu: roomWeekDanmu,
          avgDensity: +avgDensity.toFixed(3),
        },
        weekDaily: roomWeekDaily.map((s) => +(s / 3600).toFixed(2)),
        lastLiveTimestamp: lastFinished ? lastFinished.record_end_time : null,
      };
    });

    // Platform breakdown
    const platCount = {};
    for (const r of list) platCount[r.providerId] = (platCount[r.providerId] || 0) + 1;
    const platformBreakdown = Object.entries(platCount)
      .map(([k, count]) => ({
        platform: k,
        label: (PLATFORMS[k] && PLATFORMS[k].label) || k,
        color: (PLATFORMS[k] && PLATFORMS[k].color) || "#7A8899",
        cls: (PLATFORMS[k] && PLATFORMS[k].cls) || "default",
        count,
      }))
      .sort((a, b) => b.count - a.count);

    // Week chart
    const weekLabels = [];
    for (let i = 0; i < 7; i++) {
      const ts = weekStart + i * 86400000;
      weekLabels.push(i === 6 ? "今天" : dowLabelCST(ts));
    }
    const weekDuration = {
      labels: weekLabels,
      values: weekBuckets.map((s) => +(s / 3600).toFixed(1)),
    };

    // Recent events derived from history
    const events = [];
    const roomById = new Map(rooms.map((r) => [r.id, r]));
    for (const [rid, items] of historyMap) {
      const room = roomById.get(rid);
      if (!room) continue;
      for (const h of items) {
        if (h.record_start_time) {
          events.push({
            type: "rec_start",
            timestamp: h.record_start_time,
            roomName: room.name,
            text: room.name + " 开始录制" + (h.title ? " · " + h.title : ""),
            color: "#00C97C",
          });
        }
        if (h.record_end_time) {
          const durMin = Math.max(0, Math.floor((h.record_end_time - h.record_start_time) / 60000));
          events.push({
            type: "rec_end",
            timestamp: h.record_end_time,
            roomName: room.name,
            text: room.name + " 录制结束 · " + durMin + "m · 弹幕 " + (h.danma_num || 0).toLocaleString("en-US"),
            color: "#FF4757",
          });
        }
      }
    }
    // Synthetic "直播中但未录制" warnings (no historical timestamp; tagged as "now")
    for (const r of rooms) {
      if (r.living && !r.recording) {
        events.push({
          type: "live_no_rec",
          timestamp: now,
          roomName: r.name,
          text: r.name + " 直播中,录制未开启",
          color: "#FFB020",
        });
      }
    }
    events.sort((a, b) => b.timestamp - a.timestamp);

    return {
      ok: true,
      stats: {
        total: list.length,
        living: list.filter((r) => r.liveInfo && r.liveInfo.living).length,
        recording: list.filter((r) => r.state === "recording").length,
        todayDuration: Math.floor(todayDuration),
        todayDanmu,
        todayInteract,
        todayBytesEstimate: Math.floor(todayDuration * APPROX_BYTES_PER_SECOND),
      },
      rooms,
      platformBreakdown,
      weekDuration,
      recentEvents: events.slice(0, 12),
      timestamp: now,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), timestamp: now };
  }
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>主播聚合大屏</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #080C12;
  --bg-card: #0D1320;
  --bg-card2: #111826;
  --border: rgba(255,255,255,0.07);
  --border-hover: rgba(255,255,255,0.16);
  --text-1: #DDE3EE;
  --text-2: #7A8899;
  --text-3: #4A5568;
  --green: #00C97C;
  --green-dim: rgba(0,201,124,0.12);
  --red: #FF4757;
  --red-dim: rgba(255,71,87,0.12);
  --amber: #FFB020;
  --amber-dim: rgba(255,176,32,0.12);
  --blue: #3D8EFF;
  --blue-dim: rgba(61,142,255,0.12);
  --purple: #9B7FFF;
  --gold: #FFD15C;
  --bili: #4A90E2;
  --douyu: #FF6B35;
  --huya: #FFB020;
  --douyin: #9B7FFF;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text-1);
  font-family: 'Noto Sans SC', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  min-height: 100vh;
  padding: 20px;
}
.mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
a { color: inherit; text-decoration: none; }

.topbar {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 18px;
  border-bottom: 0.5px solid var(--border);
  padding-bottom: 14px;
}
.topbar-title {
  font-size: 17px; font-weight: 500; letter-spacing: 0.06em;
  display: flex; align-items: center; gap: 10px;
}
.logo-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red); animation: blink 1.6s infinite; }
@keyframes blink { 0%,100%{opacity:1;box-shadow:0 0 8px var(--red)} 50%{opacity:0.3;box-shadow:none} }
.topbar-right { display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--text-2); }
.topbar-right .pill { padding: 4px 12px; border-radius: 20px; border: 0.5px solid var(--border); }
.topbar-right .pill.live { background: var(--red-dim); border-color: var(--red); color: var(--red); }
.clock { font-size: 14px; color: var(--text-1); letter-spacing: 0.04em; }

.main { display: grid; grid-template-columns: 1fr 340px; gap: 18px; align-items: start; }

.section-hd { display: flex; align-items: center; gap: 10px; margin: 22px 0 12px; }
.section-hd .label { font-size: 12px; color: var(--text-3); letter-spacing: 0.1em; text-transform: uppercase; }
.section-hd .line { flex: 1; height: 0.5px; background: var(--border); }
.section-hd .count { font-size: 12px; color: var(--text-2); }

.rooms-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(max(240px, calc((100% - 30px) / 4)), 1fr));
  gap: 12px;
}
.room-card {
  background: var(--bg-card); border: 0.5px solid var(--border);
  border-radius: 12px; overflow: hidden; display: block; position: relative;
  transition: border-color 0.2s, transform 0.15s;
}
.room-card:hover { border-color: var(--border-hover); transform: translateY(-2px); }
.room-cover {
  width: 100%; aspect-ratio: 16/9;
  background-color: #1a2030;
  position: relative; overflow: hidden;
}
.room-cover-img {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: cover;
}
.room-cover-empty {
  display: flex; align-items: center; justify-content: center;
  font-size: 36px; color: rgba(255,255,255,0.2);
}
.room-tag-row {
  position: absolute; top: 10px; left: 10px;
  display: flex; gap: 4px; align-items: center;
}
.room-status-tag {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; padding: 3px 8px; border-radius: 4px;
  font-weight: 500; backdrop-filter: blur(6px);
}
.room-status-tag.live { background: rgba(255,71,87,0.85); color: #fff; }
.room-status-tag.idle { background: rgba(0,0,0,0.6); color: var(--text-2); }
.room-rec-tag {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; padding: 3px 8px; border-radius: 4px;
  font-weight: 500; backdrop-filter: blur(6px);
}
.room-rec-tag .rec-dot {
  width: 6px; height: 6px; display: inline-block;
  background: #fff;
}
.room-rec-tag.on  { background: rgba(0,201,124,0.85); color: #fff; }
.room-rec-tag.on  .rec-dot { border-radius: 50%; }
.room-rec-tag.off { background: rgba(255,71,87,0.85); color: #fff; }
.room-rec-tag.off .rec-dot { border-radius: 1px; }
.room-status-tag .dot { width: 5px; height: 5px; border-radius: 50%; background: #fff; animation: blink 1.4s infinite; }
.room-platform-tag {
  position: absolute; top: 10px; right: 10px;
  font-size: 10px; padding: 3px 7px; border-radius: 4px; font-weight: 500;
}
.plat-bili    { background: rgba(74,144,226,0.85); color: #fff; }
.plat-douyu   { background: rgba(255,107,53,0.85); color: #fff; }
.plat-huya    { background: rgba(255,176,32,0.85); color: #1a1a1a; }
.plat-douyin  { background: rgba(155,127,255,0.85); color: #fff; }
.plat-default { background: rgba(122,136,153,0.85); color: #fff; }
.room-cover-bottom {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 28px 12px 10px;
  background: linear-gradient(to top, rgba(0,0,0,0.85), transparent);
  font-size: 12px; color: rgba(255,255,255,0.95);
  display: flex; gap: 12px; justify-content: space-between;
}
.room-cover-bottom .item { display: flex; align-items: center; gap: 4px; }
.room-body { padding: 12px 14px 14px; display: flex; gap: 10px; align-items: flex-start; }
.room-avatar {
  width: 38px; height: 38px; border-radius: 50%;
  flex-shrink: 0;
  background-color: #2a3550;
  object-fit: cover;
  display: block;
}
.room-info { flex: 1; min-width: 0; }
.room-name {
  font-size: 14px; font-weight: 500; margin-bottom: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.room-title {
  font-size: 12px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.room-idle-meta { font-size: 11px; color: var(--text-3); margin-top: 3px; }

.right-col { display: flex; flex-direction: column; gap: 14px; }
.panel { background: var(--bg-card); border: 0.5px solid var(--border); border-radius: 12px; padding: 16px 18px; }
.panel-title {
  font-size: 12px; color: var(--text-2); letter-spacing: 0.06em;
  margin-bottom: 14px; display: flex; align-items: center; gap: 6px;
  text-transform: uppercase;
  cursor: pointer; user-select: none;
}
.panel-title:hover { color: var(--text-1); }
.panel-title .emoji { font-size: 14px; }
.panel-chevron {
  margin-left: auto;
  font-size: 11px; color: var(--text-3);
  transition: transform 0.2s ease;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
.panel.collapsed .panel-title { margin-bottom: 0; }
.panel.collapsed .panel-chevron { transform: rotate(-90deg); }
.panel.collapsed .panel-body { display: none; }

.lb-row {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 0; border-bottom: 0.5px solid var(--border);
}
.lb-row:last-child { border-bottom: none; }
.lb-medal {
  width: 28px; height: 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700; flex-shrink: 0;
}
.lb-medal.gold { background: rgba(255,209,92,0.18); color: var(--gold); }
.lb-cat { font-size: 10px; color: var(--text-3); letter-spacing: 0.04em; margin-bottom: 2px; }
.lb-info { flex: 1; min-width: 0; }
.lb-name { font-size: 13px; color: var(--text-1); font-weight: 500; }
.lb-val { font-size: 11px; color: var(--text-2); margin-top: 1px; }

.profile-row {
  display: flex; align-items: center; gap: 10px;
  padding: 11px 0; border-bottom: 0.5px solid var(--border);
}
.profile-row:last-child { border-bottom: none; padding-bottom: 0; }
.profile-row:first-child { padding-top: 0; }
.profile-avatar {
  width: 32px; height: 32px; border-radius: 50%;
  background-color: #2a3550; flex-shrink: 0;
  object-fit: cover;
  display: block;
}
.profile-info { flex: 1; min-width: 0; }
.profile-name {
  font-size: 13px; font-weight: 500; margin-bottom: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.profile-stats { font-size: 11px; color: var(--text-3); display: flex; gap: 8px; }
.profile-stats .stat { color: var(--text-2); }
.profile-status {
  font-size: 10px; padding: 2px 7px; border-radius: 3px; flex-shrink: 0;
}
.profile-status.live { background: var(--red-dim); color: var(--red); }
.profile-status.idle { background: rgba(255,255,255,0.04); color: var(--text-3); }

.sparkline {
  display: flex; align-items: flex-end;
  gap: 2px; height: 18px; width: 60px; margin-left: 8px; flex-shrink: 0;
}
.spark-bar { flex: 1; min-height: 2px; background: rgba(0,201,124,0.5); border-radius: 1px; }
.spark-bar.today { background: var(--green); }

.empty-row { color: var(--text-3); padding: 8px 0; font-size: 12px; text-align: center; }

.error-banner {
  background: var(--red-dim); border: 0.5px solid var(--red);
  color: var(--red); padding: 10px 14px; border-radius: 8px;
  margin-bottom: 16px; font-size: 12px;
}

.footer { text-align: center; padding: 24px 0 8px; color: var(--text-3); font-size: 11px; }
.footer a { color: var(--text-2); }

@media (max-width: 1100px) { .main { grid-template-columns: 1fr; } }
@media (max-width: 700px) {
  body { padding: 12px; }
}
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-title">
    <span class="logo-dot"></span>
    主播聚合大屏
  </div>
  <div class="topbar-right">
    <span class="pill live mono" id="t-live-count">- 主播在播</span>
    <span class="clock mono" id="clock">--:--:--</span>
  </div>
</div>

<div id="error-banner-slot"></div>

<div class="main">
  <div>
    <div class="section-hd" id="hd-live" style="display:none">
      <span class="label">正在直播</span>
      <span class="line"></span>
      <span class="count mono" id="cnt-live"></span>
    </div>
    <div class="rooms-grid" id="grid-live"></div>

    <div class="section-hd">
      <span class="label">未开播</span>
      <span class="line"></span>
      <span class="count mono" id="cnt-idle"></span>
    </div>
    <div class="rooms-grid" id="grid-idle"></div>
  </div>

  <div class="right-col">
    <div class="panel" data-panel="leaderboard">
      <div class="panel-title"><span class="emoji">🏆</span>本周之最<span class="panel-chevron">▾</span></div>
      <div class="panel-body"><div id="leaderboard"></div></div>
    </div>
    <div class="panel" data-panel="profile">
      <div class="panel-title"><span class="emoji">📊</span>主播档案 · 近 7 日<span class="panel-chevron">▾</span></div>
      <div class="panel-body"><div id="profile-list"></div></div>
    </div>
  </div>
</div>

<div class="footer">
  Powered by <a href="https://space.bilibili.com/384518666" target="_blank" rel="noopener">L-aros</a>
</div>

<script>
(function () {
  var STREAMERS = [];
  var lastError = null;

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function fmtNum(n) {
    if (n == null) return "0";
    if (n >= 10000) return (n / 1000).toFixed(1) + "k";
    return n.toLocaleString("en-US");
  }
  function fmtDuration(s) {
    s = Math.max(0, Math.floor(s));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + "h " + pad2(m) + "m";
    return m + "m " + pad2(sec) + "s";
  }
  function fmtHours(s) {
    var h = s / 3600;
    return h.toFixed(1) + "h";
  }
  function fmtRel(ts) {
    if (!ts) return "未知";
    var diff = (Date.now() - ts) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    var d = Math.floor(diff / 86400);
    return d + " 天前";
  }
  function fmtTimeShort(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    if (ts >= today.getTime()) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    if (ts >= today.getTime() - 86400000) return "昨天 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return (d.getMonth() + 1) + "/" + d.getDate();
  }
  function platCls(p) { return "plat-" + (p || "default"); }
  // Direct fetch from upstream CDN with no Referer — bypasses Worker proxy entirely.
  // Browser caches each unique URL on its own (HTTP cache + img cache).
  function imgTag(url, cls) {
    if (!url) return "";
    return '<img class="' + cls + '" src="' + escapeHtml(url) + '" referrerpolicy="no-referrer" loading="lazy" alt="" onerror="this.style.display=\\'none\\'">';
  }

  // biliLive-tools' liveStartTime is unreliable for rooms with disableAutoCheck=true:
  // each call to /recorder/manager/liveInfo returns the *current* time as liveStartTime,
  // not the actual broadcast start. liveId, however, is stable for a given session.
  // We pin the first timestamp we see for each (roomId, liveId) and persist across reloads
  // via localStorage so refresh / re-open doesn't reset the on-screen elapsed timer.
  var LIVE_START_LS_KEY = "live-start-pins/v1";
  var liveStartPins = {};
  try { liveStartPins = JSON.parse(localStorage.getItem(LIVE_START_LS_KEY) || "{}") || {}; }
  catch (e) { liveStartPins = {}; }
  function persistPins() {
    try { localStorage.setItem(LIVE_START_LS_KEY, JSON.stringify(liveStartPins)); } catch (e) {}
  }
  function stableLiveStart(room) {
    var raw = room.liveStartTimestamp || room.recordStartTimestamp || 0;
    var liveId = room.liveId || "";
    if (!liveId) return raw; // no stable id, fall back to raw
    var key = room.id + "/" + liveId;
    var pin = liveStartPins[key];
    // Update pin if: (a) first time, (b) existing pin is 0, or (c) new raw is earlier.
    // This corrects wrong initial values (e.g. /manager/liveInfo returning call time)
    // once history data arrives with the real live_start_time.
    if (!pin || pin === 0 || (raw > 0 && raw < pin)) {
      pin = Math.min(raw || Date.now(), Date.now());
      liveStartPins[key] = pin;
      // Garbage-collect entries older than 24h to keep localStorage clean
      var cutoff = Date.now() - 24 * 3600 * 1000;
      var changed = false;
      for (var k in liveStartPins) {
        if (liveStartPins[k] < cutoff && k !== key) { delete liveStartPins[k]; changed = true; }
      }
      persistPins();
    }
    return pin;
  }

  function transform(j) {
    STREAMERS = (j.rooms || []).map(function (room) {
      return {
        id: room.id,
        name: room.name,
        platform: room.platformClass,
        platformLabel: room.platformLabel,
        roomId: room.roomId,
        url: room.url,
        avatar: room.avatar || "",
        cover: room.cover || "",
        status: room.liveStatus,
        recording: room.recording || false,
        autoCheck: room.autoCheck !== false,
        title: room.title,
        area: room.area,
        liveId: room.liveId || "",
        liveStartTime: stableLiveStart(room),
        lastLiveStart: room.lastLiveStart || 0,
        currentDanmu: room.currentDanmu || 0,
        danmaDensity: room.currentDanmaDensity || 0,
        interactNum: room.currentInteract || 0,
        lastLive: room.lastLiveTimestamp,
        weekStats: room.weekStats || { sessions: 0, totalSeconds: 0, totalDanmu: 0, avgDensity: 0 },
        weekDaily: room.weekDaily || [0,0,0,0,0,0,0],
      };
    });
  }

  function renderClock() {
    var d = new Date();
    var el = document.getElementById("clock");
    if (el) el.textContent = pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  // Stabilize cover URLs within one live session.
  // Douyin covers carry signed URLs (x-signature, expiration in query string) that rotate every
  // few minutes; if we feed the new URL into the DOM, the browser can't reuse its HTTP cache.
  // Pin the first cover we see for a given live session (keyed by streamer + liveStartTime).
  var COVER_CACHE = Object.create(null);
  function stableCover(s) {
    if (!s.cover) return "";
    var key = s.id + ":" + (s.liveStartTime || 0);
    if (!COVER_CACHE[key]) COVER_CACHE[key] = s.cover;
    return COVER_CACHE[key];
  }
  // Same idea for avatars — they often carry similar signed query strings on Douyin.
  var AVATAR_CACHE = Object.create(null);
  function stableAvatar(s) {
    if (!s.avatar) return "";
    if (!AVATAR_CACHE[s.id]) AVATAR_CACHE[s.id] = s.avatar;
    return AVATAR_CACHE[s.id];
  }

  function roomCardHtml(s) {
    var avatarUrl = stableAvatar(s);
    if (s.status === "live") {
      var coverUrl = stableCover(s);
      var coverInner = coverUrl
        ? imgTag(coverUrl, "room-cover-img")
        : "📺";
      // Render a stable placeholder for the duration; tick() fills it within 1s.
      // This keeps the rendered HTML byte-for-byte identical across polls when nothing else
      // changes, so setHtmlIfChanged() skips the DOM mutation and preserves the <img>.
      return '<a class="room-card" href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener">' +
          '<div class="room-cover' + (coverUrl ? '' : ' room-cover-empty') + '">' +
            coverInner +
            '<div class="room-tag-row">' +
              '<span class="room-status-tag live"><span class="dot"></span>LIVE</span>' +
              '<span class="room-rec-tag ' + (s.recording ? 'on' : 'off') + '">' +
                '<span class="rec-dot"></span>' +
                (s.recording ? '录制中' : '未录制') +
              '</span>' +
            "</div>" +
            '<span class="room-platform-tag ' + platCls(s.platform) + '">' + escapeHtml(s.platformLabel) + "</span>" +
            '<div class="room-cover-bottom">' +
              '<span class="item mono" data-room-dur="' + s.liveStartTime + '">⏱ ⋯</span>' +
            "</div>" +
          "</div>" +
          '<div class="room-body">' +
            imgTag(avatarUrl, "room-avatar") +
            '<div class="room-info">' +
              '<div class="room-name">' + escapeHtml(s.name) + "</div>" +
              '<div class="room-title">' + escapeHtml(s.title || "直播中") + "</div>" +
            "</div>" +
          "</div>" +
        "</a>";
    }
    return '<a class="room-card" href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener">' +
        '<div class="room-cover room-cover-empty">' +
          '<div class="room-tag-row">' +
            '<span class="room-status-tag idle">离线</span>' +
            '<span class="room-rec-tag ' + (s.autoCheck === false ? 'off' : 'on') + '">' +
              '<span class="rec-dot"></span>' +
              (s.autoCheck === false ? '录制关闭' : '录制开启') +
            '</span>' +
          "</div>" +
          '<span class="room-platform-tag ' + platCls(s.platform) + '">' + escapeHtml(s.platformLabel) + "</span>" +
          "💤" +
        "</div>" +
        '<div class="room-body">' +
          imgTag(avatarUrl, "room-avatar") +
          '<div class="room-info">' +
            '<div class="room-name">' + escapeHtml(s.name) + "</div>" +
            '<div class="room-idle-meta">' + (s.lastLive ? "上次直播 · " + escapeHtml(fmtRel(s.lastLive)) : "暂无直播记录") + "</div>" +
          "</div>" +
        "</div>" +
      "</a>";
  }

  // Cheap signature for skipping innerHTML assignment when nothing user-visible changed.
  // We feed it the full HTML string: if same as last render, skip the DOM mutation.
  // This preserves <img> elements (and their HTTP cache + decoded image) across 10s polls.
  var LAST_HTML = Object.create(null);
  function setHtmlIfChanged(el, html) {
    if (!el) return;
    var key = el.id || ("__el_" + (el._slot || (el._slot = Math.random())));
    if (LAST_HTML[key] === html) return;
    LAST_HTML[key] = html;
    el.innerHTML = html;
  }

  function renderRooms() {
    var live = STREAMERS.filter(function (s) { return s.status === "live"; });
    var idle = STREAMERS.filter(function (s) { return s.status === "idle"; });

    // Sort live streamers: longest current session first
    live.sort(function (a, b) {
      var ta = a.liveStartTime || Number.MAX_SAFE_INTEGER;
      var tb = b.liveStartTime || Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

    var liveHd = document.getElementById("hd-live");
    var liveGrid = document.getElementById("grid-live");
    if (live.length > 0) {
      liveHd.style.display = "flex";
      document.getElementById("cnt-live").textContent = live.length;
      setHtmlIfChanged(liveGrid, live.map(roomCardHtml).join(""));
    } else {
      liveHd.style.display = "none";
      setHtmlIfChanged(liveGrid, "");
    }

    document.getElementById("cnt-idle").textContent = idle.length;
    setHtmlIfChanged(
      document.getElementById("grid-idle"),
      idle.length > 0
        ? idle.map(roomCardHtml).join("")
        : '<div class="empty-row" style="grid-column:1/-1">暂无未开播主播</div>'
    );

    document.getElementById("t-live-count").textContent = live.length + " 主播在播";
  }

  function renderLeaderboard() {
    var slot = document.getElementById("leaderboard");
    if (STREAMERS.length === 0) { setHtmlIfChanged(slot, '<div class="empty-row">暂无数据</div>'); return; }
    var sorted = function (key, getter) {
      return STREAMERS.slice().sort(function (a, b) { return getter(b) - getter(a); })[0];
    };
    var byDanmu = sorted("d", function (s) { return s.weekStats.totalDanmu; });
    var byHours = sorted("h", function (s) { return s.weekStats.totalSeconds; });

    var items = [
      { cat: "弹幕王",   s: byDanmu, val: fmtNum(byDanmu.weekStats.totalDanmu) + " 条" },
      { cat: "续航之王", s: byHours, val: fmtHours(byHours.weekStats.totalSeconds) + " 直播" },
    ];

    setHtmlIfChanged(slot, items.map(function (it) {
      return '<div class="lb-row">' +
        '<div class="lb-medal gold">🏆</div>' +
        '<div class="lb-info">' +
          '<div class="lb-cat">' + escapeHtml(it.cat) + "</div>" +
          '<div class="lb-name">' + escapeHtml(it.s.name) + "</div>" +
          '<div class="lb-val mono">' + escapeHtml(it.val) + "</div>" +
        "</div>" +
      "</div>";
    }).join(""));
  }

  function sparklineHtml(daily) {
    var max = Math.max.apply(null, daily.concat([1]));
    var bars = daily.map(function (v, i) {
      var h = Math.max(2, Math.round((v / max) * 100));
      var isToday = i === daily.length - 1;
      return '<div class="spark-bar' + (isToday ? " today" : "") + '" style="height:' + h + '%"></div>';
    }).join("");
    return '<div class="sparkline">' + bars + "</div>";
  }

  function renderProfiles() {
    var sorted = STREAMERS.slice().sort(function (a, b) {
      if (a.status !== b.status) return a.status === "live" ? -1 : 1;
      return b.weekStats.totalDanmu - a.weekStats.totalDanmu;
    });
    var slot = document.getElementById("profile-list");
    if (sorted.length === 0) { setHtmlIfChanged(slot, '<div class="empty-row">暂无数据</div>'); return; }
    setHtmlIfChanged(slot, sorted.map(function (s) {
      return '<div class="profile-row">' +
        imgTag(stableAvatar(s), "profile-avatar") +
        '<div class="profile-info">' +
          '<div class="profile-name">' + escapeHtml(s.name) + "</div>" +
          '<div class="profile-stats">' +
            '<span class="stat mono">' + s.weekStats.sessions + " 场</span>" +
            '<span class="stat mono">' + fmtHours(s.weekStats.totalSeconds) + "</span>" +
            '<span class="stat mono">💬' + fmtNum(s.weekStats.totalDanmu) + "</span>" +
          "</div>" +
        "</div>" +
        sparklineHtml(s.weekDaily) +
        '<span class="profile-status ' + (s.status === "live" ? "live" : "idle") + '">' + (s.status === "live" ? "直播中" : "离线") + "</span>" +
      "</div>";
    }).join(""));
  }

  function showError(msg) {
    var slot = document.getElementById("error-banner-slot");
    slot.innerHTML = msg ? '<div class="error-banner">⚠ 数据获取失败: ' + escapeHtml(msg) + "</div>" : "";
  }

  function renderAll() {
    showError(lastError);
    renderRooms();
    renderLeaderboard();
    renderProfiles();
  }

  function tick() {
    var roomDurEls = document.querySelectorAll("[data-room-dur]");
    for (var i = 0; i < roomDurEls.length; i++) {
      var start = +roomDurEls[i].getAttribute("data-room-dur");
      var s = (Date.now() - start) / 1000;
      roomDurEls[i].textContent = "⏱ " + fmtDuration(s);
    }
  }

  async function fetchData() {
    try {
      var r = await fetch("/api/status", { cache: "no-store" });
      var j = await r.json();
      if (j.ok) {
        transform(j);
        lastError = null;
      } else {
        lastError = j.error || "未知错误";
      }
      renderAll();
    } catch (e) {
      lastError = String((e && e.message) || e);
      showError(lastError);
    }
  }

  // Initial paint from inlined data
  if (window.__INITIAL_DATA__ && window.__INITIAL_DATA__.ok) {
    transform(window.__INITIAL_DATA__);
    renderAll();
  } else if (window.__INITIAL_DATA__ && !window.__INITIAL_DATA__.ok) {
    lastError = window.__INITIAL_DATA__.error || "未知错误";
    showError(lastError);
  }

  // Collapsible panels
  function initPanels() {
    var panels = document.querySelectorAll(".panel[data-panel]");
    for (var i = 0; i < panels.length; i++) (function (p) {
      var name = p.getAttribute("data-panel");
      var key = "panel-collapsed:" + name;
      var saved = null;
      try { saved = localStorage.getItem(key); } catch (e) {}
      if (saved === "1") p.classList.add("collapsed");
      var title = p.querySelector(".panel-title");
      if (!title) return;
      title.addEventListener("click", function () {
        p.classList.toggle("collapsed");
        try { localStorage.setItem(key, p.classList.contains("collapsed") ? "1" : "0"); } catch (e) {}
      });
    })(panels[i]);
  }
  initPanels();

  renderClock();
  if (!window.__INITIAL_DATA__ || !window.__INITIAL_DATA__.ok) fetchData();

  setInterval(renderClock, 1000);
  setInterval(tick, 1000);
  setInterval(fetchData, 10000);
})();
</script>
<script charset="UTF-8" id="LA_COLLECT" src="//sdk.51.la/js-sdk-pro.min.js"></script>
<script>LA.init({id:"3Q4Dxgbl4v7XddCB",ck:"3Q4Dxgbl4v7XddCB",autoTrack:true,hashMode:true,screenRecord:true})</script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;

    if (url.pathname === "/api/status") {
      // Edge cache for 8s — multiple viewers share one upstream poll, taking ~6 subrequests off EC2
      const cacheKey = new Request("https://cache-key.invalid/api/status", { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;

      const result = await getStatusData(env);
      const resp = new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          // Browser bypasses with cache:'no-store', edge still honors this
          "Cache-Control": result.ok ? "public, max-age=8" : "public, max-age=2",
          "X-Cache": "MISS",
        },
      });
      if (result.ok) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
    }

    if (url.pathname === "/api/avatar") {
      const imgUrl = url.searchParams.get("url");
      if (!imgUrl || (!imgUrl.startsWith("http://") && !imgUrl.startsWith("https://"))) {
        return new Response("Bad request", { status: 400 });
      }
      // Cache key: the proxy URL itself (so query string varies). Edge serves repeats from cache.
      const cacheKey = new Request(request.url, { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;

      try {
        const imgResp = await fetch(imgUrl, {
          headers: { Referer: "", "User-Agent": "Mozilla/5.0" },
          cf: { cacheTtl: 86400, cacheEverything: true },
        });
        const headers = new Headers();
        headers.set("Content-Type", imgResp.headers.get("Content-Type") || "image/jpeg");
        // Successful fetches: cache aggressively (1 day). Failures: cache short to allow retry.
        if (imgResp.status === 200) {
          headers.set("Cache-Control", "public, max-age=86400, immutable");
        } else {
          headers.set("Cache-Control", "public, max-age=30");
        }
        const resp = new Response(imgResp.body, { status: imgResp.status, headers });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
      } catch {
        return new Response("Proxy error", { status: 502, headers: { "Cache-Control": "public, max-age=10" } });
      }
    }

    // HTML page with inlined initial data for instant first paint
    const initialData = await getStatusData(env);
    // Escape </script> to prevent XSS from upstream data (e.g. streamer names/titles)
    const json = JSON.stringify(initialData).replace(/<\//g, "<\\/");
    const inline = "window.__INITIAL_DATA__ = " + json + ";";
    const html = HTML.replace("(function () {", "(function () {\n" + inline + "\n");
    return new Response(html, {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        "Cache-Control": "no-store",
      },
    });
  },
};
