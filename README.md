# irouter v2.4.1

智能供应商路由代理 + 管理后台（Deno Deploy）。

## 功能
- 供应商管理（OpenAI / Anthropic / Google / Cohere + 自建）
- 内置 / 自建来源标签，自建可删除
- 操作列胶囊按钮（编辑渐变 / 删除红色），垂直居中对齐
- HMAC 登录 session（默认 admin / admin123）
- 亮色 / 暗色主题（跟随系统 + 记忆）
- 左侧栏 + 汉堡抽屉（移动端）
- 路由规则、Keys、延迟、用量、日志模块占位
- `/v1/*` 统一代理转发（客户端用 `PROXY_KEY` 鉴权）

## 部署
解压覆盖到 `irouter` 仓库根目录 → Deno Deploy 自动构建。

## 环境变量
| 变量 | 说明 | 默认 |
|---|---|---|
| `SESSION_SECRET` | cookie 签名密钥（**上线必改**） | changeme |
| `DEFAULT_ADMIN_PASS` | 管理后台密码 | admin123 |
| `PROXY_KEY` | 客户端请求鉴权 | 空（不校验） |
| `PORT` | 本地运行端口 | 8000 |

## 本地开发
```bash
deno task dev
# 访问 http://localhost:8000 → 登录 → 后台
```

## 目录
```
main.ts          # 后端（Hono）
dashboard.html   # 管理后台 UI（内联在 main.ts 模板，此文件为独立副本便于审阅）
deno.json        # hono 4.13.7
.deployignore    # 排除测试脚本
```
