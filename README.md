# irouter v2.5.3 — LLM 智能路由网关（方案 A · 精简部署）

管理首页 Dashboard + 多供应商路由 + 可视化配置 + KV 持久化。

> **本版是「方案 A」：不打包 vendor，依赖通过 `deno.json` 的 `imports` 锁定版本，由 Deno Deploy 构建时自动下载。**
> 整个项目只有 **5 个文件**，非常适合 GitHub 网页端直接推送。

---

## 📁 项目结构（仅 5 个文件，扁平根目录）

```
irouter/
├── main.ts          # 后端（Hono 服务 + 全部 API + Dashboard 聚合接口）
├── dashboard.html   # 前端管理后台（首页 Dashboard + 供应商/路由/Key 管理）
├── deno.json        # ★方案A核心：imports 锁定依赖版本
├── .deployignore
└── README.md
```

**没有 `vendor/`、没有 `node_modules/`、没有 `import_map.json`** —— 目录干净，GitHub 网页端拖拽/编辑都方便。

---

## 🔑 依赖解析方式（方案 A）

`main.ts` 顶部：

```ts
import { Hono } from "https://deno.land/x/hono@v4.13.7/mod.ts";
```

`deno.json` 的 `imports` 字段（双保险，让裸说明符 `from "hono"` 也能解析）：

```json
"imports": {
  "hono": "https://deno.land/x/hono@v4.13.7/mod.ts",
  "hono/middleware": "https://deno.land/x/hono@v4.13.7/middleware.ts",
  "std/": "https://deno.land/std@0.224.0/"
}
```

**锁定版本**：Hono `v4.13.7` + Deno std `0.224.0`，不用 `@latest`，避免构建时解析到不存在的路径。

> ⚠️ 前提：Deno Deploy 构建机能访问 `deno.land`（方案 A 需要联网下载依赖，仅首次构建）。
> 若你的构建环境无法访问外部网络，请用「方案 B 离线版」（`vendor/hono/` 内嵌）。

---

## 🚀 部署步骤

### 方式一：GitHub → Deno Deploy（推荐）

1. **在 GitHub 新建仓库**（如 `irouter`）
2. **把下面 5 个文件推到仓库根目录**（直接拖拽或用网页编辑器）：
   - `main.ts`
   - `dashboard.html`
   - `deno.json`
   - `.deployignore`
   - `README.md`
3. **Deno Deploy 关联该仓库** → 设置入口文件为 `main.ts`
4. **务必启用 Deno KV**：项目 Settings → Deno KV → Enable（否则数据不持久化）
5. **设置环境变量**：
   - `DEFAULT_ADMIN_PASS`（**必改**，默认 `admin123`）
   - `PROXY_KEY`（可选，代理鉴权密钥）
   - `SESSION_SECRET`（可选，会话密钥）

### 方式二：Deno Deploy 直接上传

把 5 个文件打包成 zip 上传即可（**不含 vendor**，体积小）。

---

## ✅ 验证

部署后：

1. 访问 `https://你的域名/` → 进入管理后台（默认首页 = Dashboard）
2. 访问 `https://你的域名/admin/api/dashboard` → 返回 JSON（stats/modelRanking/storage），**不再是 Not Found**
3. Dashboard 显示：状态卡（供应商/路由/Key/请求）、存储状态横幅、最近请求、模型排行、供应商健康度
4. 首次进入自动弹出「6 步使用指南」

---

## 📖 使用指南（后台首页也有）

1. **启用 Deno KV** → 顶栏显示 🟢 已持久化·KV
2. **添加供应商** → 供应商页 → ＋添加（名称/标识/BaseURL）
3. **配置 Key** → 编辑供应商 → 添加 API Key
4. **设置路由规则** → 路由规则页 → ＋添加（pattern + 供应商）
5. **验证转发** → `POST /v1/chat/completions`，Header 带 `Authorization: Bearer <PROXY_KEY>`
6. **监控** → 回 Dashboard 看调用排行 / 健康度

---

## 🔧 常见问题

**Q: 构建报 `Module not found "hono"`？**
A: 确认 `deno.json` 的 `imports` 字段存在且版本正确；或检查构建机能否访问 `deno.land`。

**Q: 构建机无法访问外部网络？**
A: 改用方案 B 离线版（内嵌 `vendor/hono/`，完全离线）。

**Q: `/admin/api/dashboard` 返回 Not Found？**
A: 确认部署的是本版 `main.ts`（含第 869 行 `/admin/api/dashboard` 接口）。

## VERSION

2.5.3（方案 A · 精简部署）
