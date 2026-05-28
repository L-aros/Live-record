# CLAUDE.md — 项目开发文档

## 项目概述

**Live-record** — 主播聚合大屏，基于 biliLive-tools API 的直播录制状态监控面板。

- **仓库**: https://github.com/L-aros/Live-record
- **线上地址**: https://live-record.neoclaw.asia
- **后端依赖**: biliLive-tools (API 地址: https://live.neoclaw.asia)

## 技术栈

- **前端**: 原生 HTML/CSS/JS（无框架），Google Fonts（JetBrains Mono + Noto Sans SC）
- **后端**: Cloudflare Workers（边缘计算），从 biliLive-tools API 获取数据
- **本地开发**: Express.js 代理服务器（server.js）
- **部署**: Cloudflare Workers（wrangler CLI）

## 架构设计

### Worker（核心）

`worker/src/index.js` 是主入口，职责：

1. **数据聚合** — 调用 biliLive-tools API 获取录制任务列表和录制历史，聚合为面板所需格式
2. **SSR 内联** — 首屏请求时将数据内联到 HTML 中（`window.__INITIAL_DATA__`），实现秒开
3. **图片代理** — `/api/avatar` 端点头像/封面代理，绕过 referer 检查
4. **边缘缓存** — `/api/status` 有 8 秒边缘缓存，多个访客共享一次上游请求

### 页面版本

| 文件 | 说明 | 状态 |
|------|------|------|
| `worker/src/index.js` (HTML 模板) | 主面板，内联在 Worker 中 | **生产版** |
| `demo-fan.html` | 粉丝向 Demo，独立 HTML | 活跃，依赖已部署 Worker |
| `index.html` | 早期简洁版 | 旧版，未维护 |

### 数据流

```
biliLive-tools API → Worker getStatusData() → JSON → 前端 transform() → renderAll()
                                   ↓
                            内联到 HTML (SSR)
```

### 关键数据字段

Worker 从 `/api/recorder/list` 获取房间数据，从 `/api/record-history/list` 获取录制历史。

房间对象核心字段：
- `liveInfo.living` — 是否正在直播
- `liveInfo.liveStartTime` — 开播时间（下播后仍保留）
- `liveInfo.title/avatar/cover` — 直播标题、头像、封面
- `state` — 录制状态（"recording" 等）
- `disableAutoCheck` — 是否关闭自动检测（影响 liveInfo 新鲜度）

前端对 `disableAutoCheck=true` 的房间，会额外调用 `/api/recorder/manager/liveInfo` 主动查询实时状态。

### 比特率估算

```javascript
const APPROX_BYTES_PER_SECOND = 2.5 * 1024 * 1024; // ~2.5 MB/s, 1080p/HEVC
```
用于估算录制文件大小（API 无实时文件大小接口）。

## 部署配置

### Cloudflare Workers

- **配置文件**: `worker/wrangler.toml`（真实配置，已 gitignore）
- **模板文件**: 根目录 `wrangler.toml`（含占位符，已提交）
- **Secret**: `PASSKEY`（通过 `wrangler secret put PASSKEY` 设置）
- **环境变量**: `API_BASE`（biliLive-tools API 地址）
- **路由**: `live-record.neoclaw.asia/*`（zone: neoclaw.asia）
- **Account ID**: `61eee39cf07d2a7570ae117caa66f84d`

### 本地开发

```bash
node server.js  # 启动在 localhost:3003
```

server.js 代理 biliLive-tools API（默认 localhost:3001），需要本地运行 biliLive-tools。

## biliLive-tools API 文档

- **Base URL**: `API_BASE/api`（通过 /api 代理）
- **认证**: 所有接口需要 `Authorization` 头，值为 PASSKEY
- **关键端点**:
  - `GET /api/recorder/list` — 录制任务列表（支持分页、筛选）
  - `GET /api/recorder/:id` — 任务详情
  - `POST /api/recorder/:id/start_record` — 开始录制
  - `POST /api/recorder/:id/stop_record` — 停止录制
  - `GET /api/record-history/list` — 录制历史（需 room_id, platform）
  - `POST /api/recorder/manager/liveInfo` — 批量获取直播源信息（主动查询）
  - `GET /api/common/version` — 版本查询
- **Webhook 端点**: `/api/webhook/bililiverecorder`, `/api/webhook/blrec`, 等

## 开发记录

### 2026-05-27

1. **初始开发** — 创建项目结构，Worker + 本地开发服务器 + 多版本前端
2. **主面板** — Worker 内联 HTML 模板，支持实时直播/录制状态、7 日统计、弹幕密度、排行榜
3. **粉丝向 Demo** — 独立 HTML，从 Worker API 拉取数据，增加 Hero 大卡片和最近动态
4. **图片代理** — Worker `/api/avatar` 端点，绕过抖音等平台 referer 检查
5. **边缘缓存** — `/api/status` 8 秒 Cloudflare Cache API 缓存
6. **封面稳定化** — 抖音签名 URL 会轮换，前端用 liveStartTime+roomId 做缓存 key 避免闪烁
7. **开播时间稳定化** — biliLive-tools 的 liveStartTime 对 disableAutoCheck 房间不可靠，前端用 localStorage 按 (roomId, liveId) 固定首次时间戳
8. **wrangler 安装与部署** — 全局安装 wrangler v4.95.0，认证后部署到 live-record.neoclaw.asia
9. **开源准备** — 脱敏 wrangler.toml，添加 README 和 Deploy 按钮，推送到 GitHub

### 未完成/待办

- "最近开播时间"功能（已实现但撤销，用户需求未明确）
- 更多平台支持
- 移动端适配优化
