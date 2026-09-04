# LLM Router · Deno Deploy

> **穷版 9Router** —— 单文件 Deno + Hono，免绑卡部署到 Deno Deploy，公网 `*.deno.dev` 域名。
> OpenAI / Anthropic / Google / GLM 多 provider 路由 · 协议转换 · SSE 流式 · KV 用量统计 · 可视化 Dashboard · 预算告警 · 限流

## ✨ 功能一览

| 功能 | 说明 |
|---|---|
| **🔀 自动路由** | 按 model 名前缀推断 provider（gpt→OpenAI, claude→Anthropic, gemini→Google, glm→GLM），也可用 `X-Provider` 强制指定 |
| **🔑 多 Key 轮询** | 每个 provider 支持多个 key（逗号分隔），自动 round-robin，防单 key 限速 |
| **🌊 SSE 流式透传** | `stream:true` 时直接 pipe 上游，**零缓冲**，兼容 Anthropic / Google 流式 |
| **🔐 Proxy-Key 鉴权** | `X-Proxy-Key` 校验，防盗刷；未配置则开放 |
| **⚙️ 双向协议转换** | 请求方向（OpenAI→Anthropic/Google）+ **响应方向**（Anthropic/Google→OpenAI）全自动，客户端永远收 OpenAI 格式，Cursor/Claude Code 无缝兼容 |
| **📊 KV 用量统计** | Deno KV 记录 total / 今日 / **按小时时间序列** / by-model / by-provider（四维） |
| **📈 可视化 Dashboard** | `/admin` 单 HTML，Chart.js 柱状图（24h）+ 环形图（模型分布）+ 明细表，**30 秒自动刷新**，支持清零 |
| **💰 月度预算告警** | `MONTHLY_BUDGET` 设阈值，超限返回 `429 budget_exceeded`，进度条实时显示百分比 |
| **🚦 限流** | 令牌桶，每 IP `RATE_LIMIT_RPM` 请求/分钟，超限 `429 rate_limit` |
| **📋 Models 聚合** | `GET /v1/models` 返回所有已配置 provider 的模型列表 |
| **⏱ 超时控制** | `REQUEST_TIMEOUT_MS` 默认 120s，防上游挂起 |
| **🧪 测试覆盖** | 20+ 单元测试 + 集成测试，CI 自动跑 |

## 🚀 快速部署

### 方式一：一键脚本（推荐）
```bash
curl -fsSL https://deno.land/install.sh | sh && deno login
git clone <你的仓库> && cd llm-router
./deploy.sh          # 交互填 PROXY_KEY / *_KEYS / MONTHLY_BUDGET 等
```
部署完打印公网地址：`https://xxx.deno.dev`

### 方式二：GitHub Actions（免手动）
```bash
./deploy.sh --ci       # 生成 .github/workflows/deploy.yml
# 然后 push，并在 GitHub Secrets 设 DENO_PROJECT / PROXY_KEY / *_KEYS
```

### 方式三：手动
```bash
deno deploy --project=llm-router --entrypoint=main.ts --unstable-kv \
  --env-file=<(cat <<EOF
PROXY_KEY=my-secret
OPENAI_KEYS=sk-xxx
ANTHROPIC_KEYS=sk-ant-xxx
GOOGLE_KEYS=ai-xxx
GLM_KEYS=glm-xxx
MONTHLY_BUDGET=100000
RATE_LIMIT_RPM=120
EOF
)
```

## 🔧 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXY_KEY` | _(空=开放)_ | Dashboard / 代理鉴权密钥 |
| `OPENAI_KEYS` | — | 逗号分隔的多个 key |
| `ANTHROPIC_KEYS` | — | 同上 |
| `GOOGLE_KEYS` | — | 同上 |
| `GLM_KEYS` | — | 同上 |
| `DEFAULT_PROVIDER` | `openai` | 未知 model 时的默认 provider |
| `REQUEST_TIMEOUT_MS` | `120000` | 上游请求超时 |
| `ENABLE_USAGE` | `true` | 是否记录用量（需 KV） |
| `MONTHLY_BUDGET` | `0` | 月度 token 预算（0=关闭），超限 429 |
| `BUDGET_INCLUDE_INPUT` | `true` | 预算是否计入 input tokens（false 则只计 output） |
| `RATE_LIMIT_RPM` | `60` | 每 IP 每分钟请求上限（0=关闭） |

## 📡 使用

### 基础调用
```bash
curl https://xxx.deno.dev/v1/chat/completions \
  -H "X-Proxy-Key: my-secret" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

### 强制指定 provider
```bash
curl ... -H "X-Provider: anthropic" -d '{"model":"anything","messages":[...]}'
```

### 查看用量
```bash
# Dashboard（浏览器）
open https://xxx.deno.dev/admin?proxy_key=my-secret

# JSON API
curl https://xxx.deno.dev/admin/usage -H "X-Proxy-Key: my-secret"
```

### 接入工具
Cursor / Claude Code / OpenWebUI 里把 **Base URL** 填 `https://xxx.deno.dev/v1`，
**API Key** 填 `PROXY_KEY`，即可走多 provider 路由。

## 🧪 本地开发
```bash
deno task dev                          # 热重载启动
deno task test                         # 单元测试
deno task test:integration             # 集成测试（自动起服务）
```

## ⚠️ 注意事项
1. **KV 仅 Production 项目可用**：Playground 预览时 `/admin/usage` 返回 `enabled:false`，但路由转发正常；升 Production 即生效。
2. **流式用量**：SSE 增量 token 难精确解析，流式请求会尝试从末尾 `[DONE]` 前的数据抽取 `usage`，若上游不返回则不计。非流式**始终精确**。
3. **协议转换范围**：Anthropic / Google 转换覆盖标准 chat completion；tool use / 图片 / thinking blocks 需自行扩展 `toAnthropic` / `toGoogle`。
4. **OAuth 类功能**：Deno Deploy 无法回弹 localhost，9Router 的 OAuth 登录部分仍需本地 + Cloudflare Tunnel。

## 🗺️ 路线图
- [ ] 按小时/天时间序列图表 ✅ (v1.3)
- [ ] 每月预算告警 ✅ (v1.3)
- [ ] 失败自动 fallback（上游 4xx/5xx 切下一个 key/provider）
- [ ] RTK / 上下文压缩中间件
- [ ] WebSocket 支持
- [ ] 管理 API：动态改 key、白名单模型

## 📄 License
MIT
