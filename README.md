# iRouter v2.5.1

LLM 统一网关 + 可视化管理后台。单文件后端 (main.ts) + 单文件前端 (dashboard.html)。

## 部署 (Deno Deploy)
1. 导入仓库，入口设为 `main.ts`
2. **Settings → Deno KV → Enable**（务必启用，否则数据重启丢失）
3. 环境变量：`DEFAULT_ADMIN_PASS` (必改), `PROXY_KEY` (可选, 客户端鉴权), `PORT` (默认8000)
4. 平台若要求 Build 命令：Hono/Deno 无需构建，设为空即可

## 使用
1. 访问 `/admin/login`，用 DEFAULT_ADMIN_PASS 登录
2. 首次进入自动弹出「6步使用指南」
3. 添加供应商 → 配置 Key → 设置路由规则
4. 客户端：`POST /v1/chat/completions`，Header `Authorization: Bearer <PROXY_KEY>`
5. 回首页 Dashboard 看调用排行 / 健康度

## API
- GET  /admin/api/dashboard        # 首页看板聚合数据
- GET  /admin/api/providers        # 供应商列表
- POST /admin/api/providers        # 添加
- PUT  /admin/api/providers/:id    # 编辑
- GET  /admin/api/routes           # 路由规则
- POST /admin/api/routes           # 添加
- GET  /admin/api/providers/:id/keys  # Key 列表
- POST /admin/api/providers/:id/keys  # 添加 Key
- GET  /admin/api/storage/status   # 存储状态 (KV/内存)
- GET  /admin/api/config            # 配置
- PUT  /admin/api/config
