# AGENT.md — AI 助手指引

## 项目简介

这是一个直播录制状态监控面板，前端是原生 HTML/CSS/JS，后端是 Cloudflare Worker。代码全部在 `worker/src/index.js` 中（约 1085 行），HTML 模板内联在 JS 字符串里。

## 代码结构速览

```
worker/src/index.js
├── 常量定义 (PLATFORMS, APPROX_BYTES_PER_SECOND)
├── API 工具函数 (apiGet, apiPost)
├── 时间工具 (todayStartCST, dowLabelCST)
├── getStatusData()          ← 核心：获取并聚合所有数据
├── HTML 模板字符串           ← 完整页面（CSS + HTML + JS）
└── export default fetch()   ← Worker 入口（路由：/api/status, /api/avatar, 页面）

demo-fan.html                ← 独立粉丝向页面，调 Worker API
index.html                   ← 旧版简洁面板（未维护）
server.js                    ← 本地开发代理（Express）
```

## 修改指南

### 修改页面样式/布局

HTML 和 CSS 都内联在 `worker/src/index.js` 的 `HTML` 常量中（第 346-1014 行）。修改后需要 `wrangler deploy` 生效。

### 修改数据逻辑

`getStatusData()` 函数（第 50-344 行）负责：
1. 调用 `/api/recorder/list` 获取房间列表
2. 对 `disableAutoCheck=true` 的房间调用 `/api/recorder/manager/liveInfo` 补充实时数据
3. 并行获取每个房间的录制历史
4. 聚合今日统计、7 日统计、每房间数据
5. 生成事件流（recentEvents）

返回格式见函数末尾的 `return` 语句。

### 修改前端渲染

JS 渲染逻辑在 HTML 模板的 `<script>` 标签内（约第 636-1009 行）：
- `transform()` — 将 API 数据转为前端 streamer 数组
- `renderRooms()` — 渲染房间卡片网格
- `renderLeaderboard()` — 渲染排行榜
- `renderProfiles()` — 渲染主播档案
- `tick()` — 每秒更新直播时长

### 图片处理

抖音等平台的头像/封面有 referer 检查。Worker 的 `/api/avatar` 端点做代理：
- 前端直接用原始 URL（`referrerpolicy="no-referrer"`）
- 如果需要代理，拼接 `/api/avatar?url=encodeURIComponent(imgUrl)`
- `demo-fan.html` 使用代理模式

### 封面/头像缓存策略

抖音签名 URL 会轮换。前端用 `stableCover()` 和 `stableAvatar()` 按 session 固定 URL，避免图片闪烁。

## 部署

```bash
cd worker
wrangler deploy    # 部署到 live-record.neoclaw.asia
```

Secret 管理：
```bash
wrangler secret put PASSKEY    # 设置/更新 API 密钥
```

## API 调用注意事项

- biliLive-tools 的 `/api/recorder/manager/liveInfo` 会把 liveStartTime 设为调用时间（非真实开播时间），不能覆盖已有的 liveStartTime
- 录制历史按 30 分钟切割段，同一场直播的多个段需要按 `live_id` 聚合
- `danma_density` 是弹幕条/秒，需要按录制时长加权平均
- CST 时区偏移：`+8h`（`CST_OFFSET_MS = 8 * 3600 * 1000`）

## 注意事项

- 修改 `worker/src/index.js` 后必须 `wrangler deploy` 才能在线上生效
- `worker/wrangler.toml` 包含真实密钥，已 gitignore，不要提交
- 根目录 `wrangler.toml` 是模板（占位符），可安全提交
- `demo-fan.html` 依赖已部署的 Worker API（`https://live-record.neoclaw.asia`）
- 本地开发用 `server.js`，需要本地运行 biliLive-tools
