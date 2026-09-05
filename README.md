# 🛰️ LLM Router · v2.2.0

> 一个 Deno 部署的 OpenAI 兼容代理网关：**一个 endpoint 聚合 20+ 供应商**，自带完整可视化后台、智能路由、协议转换、健康监控、Key 自动管理、用量统计。

[![Deploy](https://img.shields.io/badge/deploy-Deno%20Deploy-000?logo=deno)](https://dash.deno.com/new)
[![Version](https://img.shields.io/badge/version-2.2.0-blue)](.)

---

## ✨ 功能

### 🎯 核心
- **一个 endpoint 聚合 20+ 供应商** — Cursor / Claude Code / OpenWebUI 只需填一个 Base URL
- **OpenAI 兼容协议转换** — 自动把 Anthropic / Google / GLM 格式归一化为 OpenAI 格式
- **智能路由** — 按模型名 → 供应商优先级，支持通配符 fallback（`*gpt*` → openai,openrouter）
- **流式响应** — SSE 透传（兼容 ChatGPT 客户端）

### 🌐 内置供应商（20 家）
| 类别 | 供应商 |
|---|---|
| **国产（多有免费额度）** | DeepSeek、通义千问、混元、豆包/火山方舟、Kimi、智谱 GLM |
| **聚合/低价** | 硅基流动、Groq（极速）、Together、OpenRouter、Fireworks、Novita、PPIO、Mistral、Cohere |
| **国际官方** | OpenAI、Anthropic、Google |
| **自建/私有** | Ollama、vLLM、OneAPI（默认禁用，填 key 即用） |

### 🎛️ 可视化后台 `/admin`（6 Tab）
| Tab | 功能 |
|---|---|
| 📡 **供应商** | 增删改、启用开关、协议/baseUrl/默认模型、**一键连通性测试** |
| 🔑 **Keys** | 每个供应商管理多个 Key、脱敏、**失败自动摘除 + 一键恢复** |
| 📊 **延迟** | P50 / P95 / Avg / Max，各供应商对比 |
| 💰 **用量** | Token 用量按供应商/模型统计、占比、**日/月预算拦截** |
| 📋 **日志** | 请求审计（时间/模型/供应商/状态码/延迟/Token），可筛选 |
| ⚙️ **路由规则** | 拖拽式优先级、通配 fallback、降级策略 |

### 🔧 运维
- **KV 持久化配置中心** — 运行时改动存 Deno KV，重启不丢；`SEED_KEYS` 做初始种子
- **健康监控** — 定时 ping 各供应商，状态灯（🟢🟡🔴）
- **Key 失效自动摘除** — 连续 401/403 达到阈值自动禁用 + **Webhook 告警**
- **多 Proxy Key 鉴权** — 白名单模型、RPM 限速、过期时间
- **配置导入/导出** — 一键备份/迁移
- **暗色 UI** — 响应式，手机可用

---

## 🚀 快速开始

### 1. 准备仓库
```bash
git clone <your-repo>/irouter.git
cd irouter
```

### 2. 本地验证（可选，需 Node 18+）
```bash
node check.cjs        # 静态检查（import 清洁度、功能覆盖）
node test_full.cjs    # 单元测试
node integration_full.cjs  # 集成测试
```

### 3. 部署到 Deno Deploy
**方式 A：网页（推荐）**
1. 推送代码到 GitHub 仓库 `irouter`
2. 打开 [dash.deno.com/new](https://dash.deno.com/new) → 关联仓库
3. **Entry 填 `main.ts`** → Deploy

**方式 B：CLI**
```bash
deno deploy --project=irouter --entry=main.ts
```

### 4. 设置环境变量（Settings → Environment Variables）

| 变量 | 必填 | 说明 | 示例 |
|---|---|---|---|
| `PROXY_KEY` | ✅ | 客户端访问密钥（逗号可多个） | `sk-my-secret-123` |
| `SEED_KEYS` | 推荐 | 初始供应商 Key，`provider:key` 格式 | `deepseek:sk-xxx,siliconflow:sk-yyy` |
| `DAILY_TOKEN_BUDGET` | ❌ | 每日 Token 预算，超限拦截 | `1000000` |
| `MONTHLY_BUDGET` | ❌ | 每月预算 | `30000000` |
| `RATE_LIMIT_RPM` | ❌ | 全局每分钟请求限制 | `600` |
| `HEALTH_CHECK_INTERVAL_MS` | ❌ | 健康检查间隔，默认 5 分钟 | `300000` |
| `KEY_FAIL_THRESHOLD` | ❌ | Key 连续失败几次摘除，默认 3 | `3` |
| `KEY_AUTO_RECOVER` | ❌ | 摘除后自动重试，默认 true | `true` |
| `WEBHOOK_URL` | ❌ | 告警推送（Discord/Slack/飞书） | `https://discord.com/api/webhooks/...` |
| `WEBHOOK_SECRET` | ❌ | Webhook 签名密钥 | `xxx` |
| `LOG_RETENTION_HOURS` | ❌ | 日志保留时长，默认 7 天 | `168` |
| `ADMIN_USER` / `ADMIN_PASS` | ❌ | 后台登录（留空则随 PROXY_KEY） | `admin` |
| `ENABLE_USAGE` | ❌ | 是否记录用量，默认 true | `true` |

---

## 🔌 客户端配置

部署后得到域名 `https://xxx.deno.dev`，在任何 OpenAI 兼容客户端填：

| 客户端 | Base URL | API Key |
|---|---|---|
| **Cursor** | `https://xxx.deno.dev/v1` | 你的 `PROXY_KEY` |
| **Claude Code** | `https://xxx.deno.dev/v1` | `PROXY_KEY` |
| **OpenWebUI** | `https://xxx.deno.dev/v1` | `PROXY_KEY` |
| **OpenAI SDK** | `https://xxx.deno.dev/v1` | `PROXY_KEY` |

```python
from openai import OpenAI
client = OpenAI(base_url="https://xxx.deno.dev/v1", api_key="sk-my-secret-123")
client.chat.completions.create(model="deepseek-chat", messages=[{"role":"user","content":"你好"}])
```

---

## 📡 API 端点

### 代理（OpenAI 兼容）
- `GET  /v1/models` — 列出所有可用模型
- `POST /v1/chat/completions` — 聊天补全（自动路由 + 协议转换）

### 管理后台 `/admin`
浏览器打开 `https://xxx.deno.dev/admin`，用 `PROXY_KEY` 鉴权。

### 管理 API（`/admin/api/*`）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/DELETE | `/providers` | 供应商 CRUD |
| POST/DELETE | `/providers/:id/keys` | 管理 Key |
| POST | `/providers/:id/keys/:keyId/recover` | 恢复被摘除的 Key |
| POST | `/providers/:id/test` | 连通性测试 |
| GET/POST/DELETE | `/routes` | 路由规则 |
| GET/POST/DELETE | `/proxy-keys` | Proxy Key |
| GET | `/stats/latency` | 延迟统计 |
| GET | `/stats/usage` | Token 用量 |
| GET | `/logs` | 请求日志（`?provider=&limit=`） |
| GET/POST | `/health/check` | 健康检查 |
| GET | `/alerts` | 告警列表 |
| GET | `/config/export` | 导出配置 |
| POST | `/config/import` | 导入配置 |

---

## 🗂️ 项目结构

```
irouter/
├── main.ts                      # 单文件核心（~790 行，含完整 Dashboard UI）
├── deno.json                    # Deno 配置（JSR 依赖）
├── deploy.sh                    # 一键部署脚本
├── package.json                 # 测试脚本
├── check.cjs                    # 静态检查（import 清洁度）
├── test_full.cjs                # 单元测试（逻辑验证）
├── integration_full.cjs         # 集成测试（端到端链路）
├── README.md                    # 本文档
└── .github/workflows/deploy.yml # GitHub Actions CI
```

> **单文件设计**：除 Hono 外无外部模块依赖，Dashboard UI 完全内联，避免之前 `modules.js` 拆分导致的部署问题。

---

## 🔧 常见问题

### Q: 部署后 502 / 无响应？
- 确认 **Entry 是 `main.ts`**，不是 `index.ts`
- 查看 Runtime Logs：是否 `PROXY_KEY` 未设导致鉴权失败
- 确认供应商 Key 有效（后台 → Keys → 测试连通性）

### Q: Dashboard 打不开 / 空白？
- 访问 `/admin` 会要求鉴权，用 `PROXY_KEY` 作为 Bearer Token
- 检查浏览器控制台是否有 JS 报错

### Q: 流式响应不工作？
- 客户端需明确设置 `stream: true`
- 部分供应商（如 GLM）对 SSE 支持有限，会自动降级为非流式

### Q: KV 配置不持久？
- **需 Production 项目**（Playground 预览可能不持久）
- 检查环境变量 `ENABLE_USAGE=true`

### Q: 如何添加自定义供应商？
后台 → 供应商 Tab → 添加，填 ID/名称/协议/Base URL/默认模型即可。任何兼容 OpenAI 的服务（包括自建 vLLM、Ollama）都能接入。

---

## 📄 License

MIT
