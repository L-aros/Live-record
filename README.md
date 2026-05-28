# Live-record

主播聚合大屏 — 基于 [biliLive-tools](https://github.com/renmu123/biliLive-tools) API 的直播录制状态监控面板。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/L-aros/Live-record)

## 功能

- 实时显示所有监控房间的直播/录制状态
- 支持 B站、斗鱼、虎牙、抖音多平台
- 7 日直播统计（时长、弹幕、互动、开播次数）
- 弹幕密度排行、本周之最
- 主播档案与迷你柱状图
- 封面/头像 CDN 缓存代理
- Cloudflare Worker 边缘部署，首屏秒开（SSR 内联数据）

## 项目结构

```
├── worker/
│   ├── src/index.js           # Cloudflare Worker 主入口
│   ├── wrangler.toml          # 实际部署配置（不提交，含密钥）
│   └── package.json
├── wrangler.toml              # 部署配置模板（含占位符）
├── demo-fan.html              # 粉丝向静态 Demo（依赖已部署的 Worker）
├── index.html                 # 早期简洁版面板
├── server.js                  # 本地开发代理服务器
└── README.md
```

## 快速开始

### 一键部署

点击上方按钮，选择你的 Cloudflare 账户即可自动导入部署。部署前在编辑器中修改 `wrangler.toml` 填入你的配置。

### 本地开发

```bash
# 1. 启动本地 API 代理（需要 biliLive-tools 运行在 localhost:3001）
node server.js

# 2. 浏览器打开
# http://localhost:3003
```

### 手动部署

```bash
# 1. 复制配置并填入你的信息
cp wrangler.toml worker/wrangler.toml
# 编辑 worker/wrangler.toml

# 2. 登录 Cloudflare
npx wrangler login

# 3. 设置 API 密钥
npx wrangler secret put PASSKEY

# 4. 部署
npx wrangler deploy
```

### 配置说明

| 变量 | 说明 |
|------|------|
| `API_BASE` | biliLive-tools API 地址，如 `https://your-api-host.com` |
| `PASSKEY` | API 认证密钥（通过 wrangler secret 设置） |

## 依赖

- [biliLive-tools](https://github.com/renmu123/biliLive-tools) — 直播录制后端
- [Cloudflare Workers](https://workers.cloudflare.com/) — 边缘计算平台
- [Google Fonts](https://fonts.google.com/) — JetBrains Mono + Noto Sans SC

## License

MIT
