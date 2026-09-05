# irouter v2.2.0

LLM API 聚合网关 + 可视化管理系统（Deno + Hono，单文件 + 独立 Dashboard）。

## 功能
- **20+ 内置供应商**：DeepSeek、通义、混元、豆包、Kimi、智谱、硅基流动、Groq、Together、OpenRouter、Mistral、Cohere、OpenAI、Anthropic、Google、Ollama、vLLM、OneAPI 等
- **协议转换**：OpenAI / Anthropic / Google / GLM 四种协议双向归一化
- **KV 配置中心**：运行时改动持久化，`SEED_KEYS` 做初始种子
- **可视化后台 `/admin`**（6 Tab）：供应商 / Keys / 延迟 / 用量 / 日志 / 路由规则
- **健康监控 + Key 自动摘除 + Webhook 告警**
- **延迟 P50/P95、Token 用量统计、审计日志、路由优先级、多 Proxy Key、预算拦截、配置导入/导出**

## 部署（Deno Deploy）
1. 把本目录文件推到 GitHub 仓库
2. [dash.deno.com/new](https://dash.deno.com/new) 关联仓库 → Entry: `main.ts`
3. 设置环境变量：`PROXY_KEY`（必填）、`SEED_KEYS`（格式 `provider:key`，可选）、`ADMIN_USER`/`ADMIN_PASS`（后台登录，可选）
4. Deploy

> 注意：`.deployignore` 会让 deployctl 自动排除测试脚本，部署包仅含 `main.ts` + `dashboard.html` + `deno.json`。

## 本地验证
```
node test_logic.cjs     # 逻辑回归（28 项）
```

## 环境变量
| 变量 | 说明 | 默认 |
|---|---|---|
| `PROXY_KEY` | 客户端访问密钥（逗号分隔多 key） | 空（不校验） |
| `SEED_KEYS` | 初始供应商 key，`provider:key` 逗号分隔 | 空 |
| `MONTHLY_BUDGET` / `DAILY_TOKEN_BUDGET` | Token 预算上限 | 0（不限制） |
| `HEALTH_CHECK_INTERVAL_MS` | 健康检查间隔 | 300000 |
| `KEY_FAIL_THRESHOLD` | Key 连续失败多少次自动摘除 | 3 |
| `WEBHOOK_URL` | 告警推送地址 | 空 |
| `LOG_RETENTION_HOURS` | 日志保留时长 | 168 |

详见 `main.ts` 顶部 ENV 定义。
