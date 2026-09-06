# irouter · LLM 聚合网关 v2.4.0

单文件 Deno 服务：OpenAI 兼容代理 + 多供应商聚合 + Web 管理后台。

## 部署（Deno Deploy）

把本目录 5 个文件推到仓库根目录，`main.ts` 作为入口。

**环境变量：**
| 变量 | 必填 | 说明 |
|---|---|---|
| `PROXY_KEY` | 是 | 客户端请求鉴权（可逗号分隔多个） |
| `SESSION_SECRET` | 强烈建议 | 后台登录 cookie 签名密钥，**上线前必改** |
| `DEFAULT_ADMIN_PASS` | 否 | 后台默认密码，默认 `admin123` |
| `SEED_KEYS` | 否 | 启动时种子供应商，如 `deepseek:sk-xxx,openrouter:sk-xxx` |

## 后台登录

- 默认账号：**`admin` / `admin123`**
- 登录后左下角「🔒 修改密码」改为自己的（≥6 位），改完自动登出
- 密码存 Deno KV，重启/重部署不丢
- 访问 `/` 即进后台（首页与 `/admin` 相同）

## 功能

- ✅ 首页直接显示管理后台
- ✅ 版本号全局一致（单一数据源 `VERSION = "2.4.0"`）
- ✅ 独立登录页 + HMAC-SHA256 session（恒定时间比对、7 天有效期）
- ✅ 左侧栏 + 汉堡三道杠（手机端抽屉）
- ✅ 亮色 / 暗色主题（localStorage 记忆 + 跟随系统）
- ✅ 供应商 CRUD · 一键恢复内置供应商 · Keys 管理/测试/恢复
- ✅ 延迟/用量统计 · 请求日志 · 路由规则 · 配置导入导出

## 文件

- `main.ts` — 后端（Hono），首页渲染后台 + 全部 API
- `dashboard.html` — 前端（6 Tab 后台 UI，左侧栏 + 主题 + 登录）
- `deno.json` — hono 4.13.7 精确锁定
- `.deployignore` — 排除测试脚本
