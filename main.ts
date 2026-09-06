// irouter v2.4.1 - 供应商管理代理（含管理后台）
// Deno Deploy 入口

const VERSION = "2.4.1";

import { Hono } from "hono";
import { cors } from "hono/cors";

// ========== 类型 ==========
interface Provider {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  enabled: boolean;
  builtin: boolean;
  isCustom?: boolean;
  weight: number;
  timeout: number;
  maxRetries: number;
  latencyMs: number;
  successRate: number;
  dailyLimit: number;
  usedToday: number;
  lastUsed: number;
  createdAt: number;
}

interface RouteRule {
  id: string;
  name: string;
  match: string;
  providerId: string;
  priority: number;
  enabled: boolean;
}

// ========== 存储 ==========
const KV_PROVIDERS = ["providers"] as const;
const KV_ROUTES = ["routes"] as const;

async function getKV<T>(key: readonly string[], fallback: T): Promise<T> {
  try {
    const kv = await Deno.openKv();
    const r = await kv.get<T>(key as unknown as string[]);
    kv.close();
    return (r.value as T) ?? fallback;
  } catch {
    return fallback;
  }
}
async function setKV<T>(key: readonly string[], value: T): Promise<void> {
  try {
    const kv = await Deno.openKv();
    await kv.set(key as unknown as string[], value);
    kv.close();
  } catch {}
}

let providers: Provider[] = [];
let routes: RouteRule[] = [];

async function loadDashboard() {
  providers = await getKV<Provider[]>(KV_PROVIDERS, []);
  routes = await getKV<RouteRule[]>(KV_ROUTES, []);
  if (providers.length === 0) {
    providers = seedProviders();
    await setKV(KV_PROVIDERS, providers);
  }
}
function seedProviders(): Provider[] {
  const now = Date.now();
  return [
    { id: "openai", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "", models: ["gpt-4o", "gpt-4o-mini"], enabled: true, builtin: true, weight: 100, timeout: 60, maxRetries: 2, latencyMs: 0, successRate: 100, dailyLimit: 100000, usedToday: 0, lastUsed: now, createdAt: now },
    { id: "anthropic", name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "", models: ["claude-sonnet-4-20250514"], enabled: true, builtin: true, weight: 90, timeout: 60, maxRetries: 2, latencyMs: 0, successRate: 100, dailyLimit: 100000, usedToday: 0, lastUsed: now, createdAt: now },
    { id: "google", name: "Google", type: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "", models: ["gemini-2.5-pro"], enabled: true, builtin: true, weight: 80, timeout: 60, maxRetries: 2, latencyMs: 0, successRate: 100, dailyLimit: 100000, usedToday: 0, lastUsed: now, createdAt: now },
    { id: "cohere", name: "Cohere", type: "cohere", baseUrl: "https://api.cohere.ai/v1", apiKey: "", models: ["command-r-plus"], enabled: false, builtin: true, weight: 50, timeout: 60, maxRetries: 2, latencyMs: 0, successRate: 100, dailyLimit: 100000, usedToday: 0, lastUsed: now, createdAt: now },
  ];
}

// ========== 认证 ==========
const DEFAULT_ADMIN_PASS = Deno.env.get("DEFAULT_ADMIN_PASS") || "admin123";
const SESSION_SECRET = Deno.env.get("SESSION_SECRET") || "changeme-please-set-a-random-secret";
const PROXY_KEY = Deno.env.get("PROXY_KEY") || "";
const SESSION_DURATION = 7 * 24 * 3600 * 1000;

async function getAdminPassword(): Promise<string> {
  try { const kv = await Deno.openKv(); const r = await kv.get(["admin_pass"]); kv.close(); return (r.value as string) || DEFAULT_ADMIN_PASS; }
  catch { return DEFAULT_ADMIN_PASS; }
}
async function setAdminPassword(pass: string): Promise<void> {
  try { const kv = await Deno.openKv(); await kv.set(["admin_pass"], pass); kv.close(); } catch {}
}
async function hmacSign(data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function verifySession(cookieHeader: string | undefined): Promise<boolean> {
  if (!cookieHeader) return false;
  const m = cookieHeader.match(/irouter_sid=([^;]+)/);
  if (!m) return false;
  try {
    const [user, exp, sig] = atob(m[1]).split("|");
    if (user !== "admin") return false;
    if (Date.now() > parseInt(exp)) return false;
    const validSig = await hmacSign(user + "|" + exp);
    return sig === validSig;
  } catch { return false; }
}
async function adminAuth(c: any): Promise<boolean> {
  return verifySession(c.req.header("cookie"));
}

// ========== Hono 应用 ==========
const app = new Hono();
app.use("*", cors());

// 健康检查（含版本号，供前端同步）
app.get("/health", (c) => c.json({ ok: true, version: VERSION, time: Date.now() }));

// 首页 / 管理后台（需登录）
async function renderDashboard(c: any) {
  if (!await adminAuth(c)) return c.redirect("/admin/login");
  await loadDashboard();
  return c.html(DASHBOARD_TEMPLATE.replace(/\{\{VERSION\}\}/g, VERSION));
}
app.get("/", renderDashboard);
app.get("/admin", renderDashboard);

// 登录页（无需登录）
app.get("/admin/login", (c) =>
  c.html(LOGIN_TEMPLATE.replace(/\{\{VERSION\}\}/g, VERSION))
);

// 认证 API
app.post("/admin/api/auth/login", async (c) => {
  const { username, password } = await c.req.json();
  if (username !== "admin" || password !== await getAdminPassword())
    return c.json({ ok: false, error: "用户名或密码错误" }, 401);
  const exp = Date.now() + SESSION_DURATION;
  const sig = await hmacSign("admin|" + exp);
  const token = btoa("admin|" + exp + "|" + sig);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `irouter_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION / 1000}`,
    },
  });
});
app.post("/admin/api/auth/logout", (c) =>
  new Response(JSON.stringify({ ok: true }), { status: 200, headers: {
    "Content-Type": "application/json",
    "Set-Cookie": "irouter_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
  }})
);
app.post("/admin/api/auth/change-pass", async (c) => {
  if (!await adminAuth(c)) return c.json({ ok: false, error: "未登录" }, 401);
  const { oldPass, newPass } = await c.req.json();
  if (!newPass || newPass.length < 6) return c.json({ ok: false, error: "密码至少6位" }, 400);
  if (oldPass !== await getAdminPassword()) return c.json({ ok: false, error: "原密码错误" }, 403);
  await setAdminPassword(newPass);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: {
    "Content-Type": "application/json",
    "Set-Cookie": "irouter_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
  }});
});
app.get("/admin/api/auth/me", async (c) => {
  const ok = await adminAuth(c);
  return c.json({ ok, user: ok ? "admin" : null });
});

// 供应商 API
app.get("/admin/api/providers", async (c) => {
  if (!await adminAuth(c)) return c.json([], 401);
  await loadDashboard();
  return c.json(providers);
});
app.get("/admin/api/providers/:id", async (c) => {
  if (!await adminAuth(c)) return c.json({ error: "未登录" }, 401);
  await loadDashboard();
  const p = providers.find(x => x.id === c.req.param("id"));
  if (!p) return c.json({ error: "not found" }, 404);
  return c.json(p);
});
app.put("/admin/api/providers/:id", async (c) => {
  if (!await adminAuth(c)) return c.json({ error: "未登录" }, 401);
  await loadDashboard();
  const id = c.req.param("id");
  const body = await c.req.json();
  const idx = providers.findIndex(x => x.id === id);
  if (idx < 0) return c.json({ error: "not found" }, 404);
  providers[idx] = { ...providers[idx], ...body, id, builtin: providers[idx].builtin };
  await setKV(KV_PROVIDERS, providers);
  return c.json(providers[idx]);
});
app.post("/admin/api/providers", async (c) => {
  if (!await adminAuth(c)) return c.json({ error: "未登录" }, 401);
  await loadDashboard();
  const body = await c.req.json();
  const now = Date.now();
  const p: Provider = {
    id: body.id || (body.name || "svc").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name: body.name || "未命名",
    type: body.type || "openai",
    baseUrl: body.baseUrl || "",
    apiKey: body.apiKey || "",
    models: Array.isArray(body.models) ? body.models : [],
    enabled: body.enabled !== false,
    builtin: false,
    isCustom: true,
    weight: body.weight || 50,
    timeout: body.timeout || 60,
    maxRetries: body.maxRetries || 2,
    latencyMs: 0,
    successRate: 100,
    dailyLimit: body.dailyLimit || 0,
    usedToday: 0,
    lastUsed: now,
    createdAt: now,
  };
  providers.push(p);
  await setKV(KV_PROVIDERS, providers);
  return c.json(p, 201);
});
app.delete("/admin/api/providers/:id", async (c) => {
  if (!await adminAuth(c)) return c.json({ error: "未登录" }, 401);
  await loadDashboard();
  const id = c.req.param("id");
  const p = providers.find(x => x.id === id);
  if (!p) return c.json({ error: "not found" }, 404);
  if (p.builtin) return c.json({ error: "内置供应商不可删除" }, 400);
  providers = providers.filter(x => x.id !== id);
  await setKV(KV_PROVIDERS, providers);
  return c.json({ ok: true });
});
app.post("/admin/api/providers/reset-builtin", async (c) => {
  if (!await adminAuth(c)) return c.json({ error: "未登录" }, 401);
  providers = seedProviders();
  await setKV(KV_PROVIDERS, providers);
  return c.json({ ok: true, providers });
});

// 路由规则 API
app.get("/admin/api/routes", async (c) => {
  if (!await adminAuth(c)) return c.json([], 401);
  await loadDashboard();
  return c.json(routes);
});
app.post("/admin/api/routes", async (c) => {
  if (!await adminAuth(c)) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json();
  const r: RouteRule = { id: crypto.randomUUID(), name: body.name || "规则", match: body.match || "*", providerId: body.providerId || "", priority: body.priority || 0, enabled: true };
  routes.push(r);
  await setKV(KV_ROUTES, routes);
  return c.json(r, 201);
});
app.delete("/admin/api/routes/:id", async (c) => {
  if (!await adminAuth(c)) return c.json({ error: "未登录" }, 401);
  routes = routes.filter(x => x.id !== c.req.param("id"));
  await setKV(KV_ROUTES, routes);
  return c.json({ ok: true });
});

// 代理转发（客户端用 PROXY_KEY 鉴权）
app.all("/v1/*", async (c) => {
  const key = c.req.header("x-proxy-key") || "";
  if (PROXY_KEY && key !== PROXY_KEY) return c.json({ error: "unauthorized" }, 401);
  await loadDashboard();
  const enabled = providers.filter(p => p.enabled);
  if (enabled.length === 0) return c.json({ error: "no provider" }, 503);
  const target = enabled[0];
  const upstream = target.baseUrl.replace(/\/$/, "") + c.req.path.replace(/^\/v1/, "");
  try {
    const resp = await fetch(upstream, { method: c.req.method, headers: { "content-type": "application/json", "authorization": "Bearer " + target.apiKey }, body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.raw.clone().text() });
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  } catch (e: any) {
    return c.json({ error: e.message }, 502);
  }
});

// 导出 / 导入配置
app.get("/admin/api/export", async (c) => {
  if (!await adminAuth(c)) return c.json({ error: "未登录" }, 401);
  await loadDashboard();
  return c.json({ version: VERSION, exportedAt: Date.now(), providers, routes });
});
app.post("/admin/api/import", async (c) => {
  if (!await adminAuth(c)) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json();
  if (Array.isArray(body.providers)) { providers = body.providers; await setKV(KV_PROVIDERS, providers); }
  if (Array.isArray(body.routes)) { routes = body.routes; await setKV(KV_ROUTES, routes); }
  return c.json({ ok: true });
});

// ========== 前端模板 ==========
const DASHBOARD_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>irouter 管理后台</title>
<style>
:root,[data-theme="light"]{--bg:#ffffff;--panel:#f5f7fa;--panel-2:#f0f2f6;--text:#1a1a2e;--muted:#6b7280;--line:#e3e6eb;--accent:#6d8cff;--accent-2:#a06dff;--nav-bg:#f7f8fc;--input-bg:#fff;--hover:#eef1f7;--ok:#22c55e;--warn:#f59e0b;--err:#ff6b6b;--grad:linear-gradient(135deg,#6d8cff 0%,#a06dff 100%);--shadow:0 6px 24px rgba(30,40,80,.08)}
[data-theme="dark"]{--bg:#0f1115;--panel:#171a21;--panel-2:#1c2030;--text:#e6e6e6;--muted:#8b93a3;--line:#2a2f3a;--accent:#6d8cff;--accent-2:#a06dff;--nav-bg:#11141b;--input-bg:#1f2330;--hover:#1a1e27;--ok:#3ddc97;--warn:#fbbf24;--err:#ff6b6b;--grad:linear-gradient(135deg,#6d8cff 0%,#a06dff 100%);--shadow:0 8px 28px rgba(0,0,0,.45)}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"SF Pro","Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;transition:background .2s,color .2s}
body{display:flex;min-height:100vh}
a{color:inherit}
/* 侧栏 */
.side{width:230px;background:var(--nav-bg);border-right:1px solid var(--line);display:flex;flex-direction:column;flex-shrink:0;transition:transform .25s ease;z-index:100}
.side .brand{padding:20px 18px;font-size:19px;font-weight:800;letter-spacing:.3px;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.side .brand small{display:block;font-size:11px;color:var(--muted);font-weight:500;margin-top:3px;letter-spacing:0}
.side nav{flex:1;padding:8px 10px;overflow-y:auto}
.side nav a{display:flex;align-items:center;gap:10px;padding:10px 14px;margin:2px 0;border-radius:10px;color:var(--muted);cursor:pointer;font-size:14px;transition:background .15s,color .15s}
.side nav a .ic{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:15px;opacity:.85}
.side nav a:hover{background:var(--hover);color:var(--text)}
.side nav a.active{background:var(--grad);color:#fff;box-shadow:0 4px 12px rgba(109,140,255,.4)}
.side .foot{padding:14px 18px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.side .foot .ver{font-weight:600;color:var(--text)}
.logout-btn{display:flex;align-items:center;gap:8px;width:100%;margin-top:10px;padding:9px 12px;border-radius:999px;background:var(--panel-2);border:1px solid var(--line);color:var(--text);cursor:pointer;font-size:13px;transition:background .15s,color .15s}
.logout-btn:hover{background:var(--err);color:#fff;border-color:var(--err)}
/* 主区 */
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;padding:12px 22px;background:rgba(255,255,255,.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
[data-theme="dark"] .topbar{background:rgba(15,17,21,.72)}
.topbar h2{margin:0;font-size:17px;font-weight:700}
.topbar .spacer{flex:1}
.theme-btn{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:6px 12px;cursor:pointer;font-size:15px;transition:background .15s}
.theme-btn:hover{background:var(--hover)}
.content{padding:22px;overflow:auto}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:var(--shadow)}
.card h3{margin:0 0 14px;font-size:15px;font-weight:700}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.toolbar .spacer{flex:1}
input,select,textarea{background:var(--input-bg);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:13px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(109,140,255,.18)}
.primary{background:var(--grad);color:#fff;border:none;border-radius:10px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(109,140,255,.35);transition:transform .1s,box-shadow .15s}
.primary:hover{box-shadow:0 6px 20px rgba(109,140,255,.5)}
.primary:active{transform:scale(.96)}
/* 表格 */
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{text-align:left;padding:10px 12px;color:var(--muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;border-bottom:1px solid var(--line);background:var(--panel-2);position:sticky;top:0}
tbody td{padding:12px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:hover{background:var(--panel-2)}
tbody tr:hover .row-actions{background:transparent}
.name-cell{display:flex;align-items:center;gap:10px}
.name-cell .txt{font-weight:600}
.name-cell .sub{color:var(--muted);font-size:12px}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;box-shadow:0 0 0 3px rgba(0,0,0,.05)}
.dot.ok{background:var(--ok);box-shadow:0 0 8px rgba(34,197,94,.5)}
.dot.warn{background:var(--warn)}
.dot.err{background:var(--err)}
.tag{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:var(--panel-2);color:var(--muted)}
.tag.builtin{background:var(--panel-2);color:var(--muted)}
.tag.custom{background:rgba(109,140,255,.14);color:var(--accent)}
/* ===== 操作列：胶囊按钮（v2.4.1）===== */
.row-actions{background:transparent!important;vertical-align:middle;padding-top:.55rem;padding-bottom:.55rem;text-align:right;white-space:nowrap}
.btn-group{display:inline-flex;align-items:center;justify-content:center;gap:0;background:transparent;padding:0;border-radius:0;line-height:1;vertical-align:middle}
.btn-group .btn{display:inline-flex;align-items:center;justify-content:center;height:28px;line-height:28px;padding:0 14px;font-size:13px;font-weight:600;border:none;color:#fff;cursor:pointer;vertical-align:middle;transition:filter .12s,transform .1s}
.btn-group .btn:hover{filter:brightness(1.08)}
.btn-group .btn:active{transform:scale(.94)}
.btn-group .btn.edit{background:linear-gradient(135deg,#6d8cff 0%,#a06dff 100%);border-radius:14px 0 0 14px}
.btn-group .btn.delete{background:#ff6b6b;border-radius:0 14px 14px 0}
.btn-group .btn:only-child{border-radius:14px}
@media(max-width:760px){.side{position:fixed;inset:0 auto 0 0;height:100%;transform:translateX(-100%);box-shadow:var(--shadow)}.side.open{transform:translateX(0)}.scrim{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:90}.scrim.open{display:block}.burger{display:inline-flex!important}.content{padding:14px}.topbar{padding:10px 14px}}
.burger{display:none;flex-direction:column;gap:4px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px;cursor:pointer;margin-right:6px}
.burger span{width:20px;height:2px;background:var(--text);border-radius:2px}
/* 弹窗 */
.modal{position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;z-index:200;padding:20px;animation:fade .18s ease}
.modal.open{display:flex}
@keyframes fade{from{opacity:0}to{opacity:1}}
.modal .box{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px;width:min(520px,100%);max-height:90vh;overflow:auto;box-shadow:0 24px 60px rgba(0,0,0,.35);animation:pop .2s cubic-bezier(.2,.9,.3,1.2)}
@keyframes pop{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}
.modal h3{margin:0 0 18px;font-size:17px}
.field{margin-bottom:14px}
.field label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px;font-weight:600}
.field .hint{font-size:11px;color:var(--muted);margin-top:4px}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
.cancel{background:var(--panel-2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:8px 16px;cursor:pointer;font-size:13px}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--text);color:var(--bg);padding:10px 20px;border-radius:999px;font-size:13px;font-weight:600;opacity:0;pointer-events:none;transition:all .25s;z-index:300;box-shadow:var(--shadow)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.muted{color:var(--muted)}
.empty{text-align:center;padding:40px;color:var(--muted)}
.hidden{display:none!important}
</style>
</head>
<body>
<button class="burger" onclick="toggleSide()"><span></span><span></span><span></span></button>
<div class="scrim" id="scrim" onclick="toggleSide()"></div>
<div class="side" id="side">
  <div class="brand">⚡ irouter<small>智能供应商路由</small></div>
  <nav id="nav">
    <a data-tab="providers"><span class="ic">📡</span>供应商</a>
    <a data-tab="keys"><span class="ic">🔑</span>Keys</a>
    <a data-tab="latency"><span class="ic">📊</span>延迟</a>
    <a data-tab="usage"><span class="ic">💰</span>用量</a>
    <a data-tab="logs"><span class="ic">📋</span>日志</a>
    <a data-tab="routes"><span class="ic">⚙️</span>路由规则</a>
  </nav>
  <div class="foot">
    <div class="ver" id="ver">v{{VERSION}}</div>
    <button class="logout-btn" onclick="logout()"><span>⏻</span><span>退出登录</span></button>
  </div>
</div>
<div class="main">
  <div class="topbar">
    <button class="burger" onclick="toggleSide()"><span></span><span></span><span></span></button>
    <h2 id="pageTitle">供应商</h2>
    <span class="spacer"></span>
    <button class="theme-btn" onclick="toggleTheme()" id="themeBtn" title="切换主题">🌙</button>
  </div>
  <div class="content" id="content"></div>
</div>

<script>
const API="/admin/api";
let currentTab="providers", providers=[];
const $=(s)=>document.querySelector(s);
const esc=(s)=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function toggleSide(){ $("#side").classList.toggle("open"); $("#scrim").classList.toggle("open"); }
function toast(msg){const t=$("#toast")||(function(){const d=document.createElement("div");d.className="toast";document.body.appendChild(d);return d;}());t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200);}
async function fetchWithAuth(path,opts={}){const r=await fetch(API+path,Object.assign({credentials:"same-origin",headers:{"Content-Type":"application/json"}},opts));if(r.status===401){location.href="/admin/login";throw new Error("未登录");}return r;}
function logout(){fetch(API+"/auth/logout",{method:"POST"}).finally(()=>location.href="/admin/login");}
function changePass(){const o=prompt("原密码："),n=prompt("新密码（至少6位）：");if(!o||!n)return;fetchWithAuth("/auth/change-pass",{method:"POST",body:JSON.stringify({oldPass:o,newPass:n})}).then(r=>r.json()).then(d=>{if(d.ok){toast("已修改，请重新登录");setTimeout(logout,800);}else toast(d.error||"修改失败");}).catch(()=>toast("修改失败"));}
function toggleTheme(){const cur=document.documentElement.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");const next=cur==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",next);localStorage.setItem("theme",next);$("#themeBtn").textContent=next==="dark"?"🌙":"☀️";}

// 事件委托：编辑 / 删除（v2.3.6+）
document.addEventListener("click",e=>{
  const btn=e.target.closest("button[data-action]");
  if(!btn)return;
  const action=btn.dataset.action, id=btn.dataset.id;
  if(action==="edit")openProvider(id);
  if(action==="delete")deleteProvider(id);
});

function setActive(tab){
  document.querySelectorAll("#nav a").forEach(a=>a.classList.toggle("active",a.dataset.tab===tab));
  const titles={providers:"供应商",keys:"Keys",latency:"延迟",usage:"用量",logs:"日志",routes:"路由规则"};
  $("#pageTitle").textContent=titles[tab]||"管理后台";
}
async function loadTab(tab){
  currentTab=tab;setActive(tab);
  if(tab==="providers")return renderProviders();
  if(tab==="routes")return renderRoutes();
  $("#content").innerHTML='<div class="card"><h3>'+tab+'</h3><div class="empty">该模块暂未实现</div></div>';
}
function renderProviders(){
  const rows=providers.map(p=>{
    const dot=p.enabled?"ok":(p.successRate>80?"warn":"err");
    const statusDot='<span class="dot '+dot+'" title="'+(p.enabled?"启用":"停用")+'"></span>';
    const sub=esc(p.type||"");
    return '<tr data-id="'+esc(p.id)+'">'
      +'<td><div class="name-cell">'+statusDot+'<div><div class="txt">'+esc(p.name)+'</div><div class="sub">'+sub+'</div></div></div></td>'
      +'<td><span class="tag '+(p.builtin?"builtin":"custom")+'">'+(p.builtin?"内置":"自建")+'</span></td>'
      +'<td class="muted">0/0</td>'
      +'<td class="muted">-</td>'
      +'<td class="row-actions"><span class="btn-group">'
        +'<button class="btn edit" type="button" data-action="edit" data-id="'+esc(p.id)+'">编辑</button>'
        +(p.builtin?'':'<button class="btn delete" type="button" data-action="delete" data-id="'+esc(p.id)+'">删除</button>')
      +'</span></td>'
    +'</tr>';
  }).join("");
  $("#content").innerHTML=''
    +'<div class="card">'
    +'<div class="toolbar"><h3 style="margin:0">供应商列表</h3><span class="spacer"></span><button class="primary" onclick="openProvider()">＋ 添加供应商</button></div>'
    +'<div style="overflow:auto">'
    +'<table><thead><tr><th>名称</th><th>来源</th><th>限额</th><th>延迟</th><th style="text-align:right">操作</th></tr></thead>'
    +'<tbody>'+(rows||'<tr><td colspan="5" class="empty">暂无供应商</td></tr>')+'</tbody></table>'
    +'</div></div>';
}
function openProvider(id){
  const p=id?providers.find(x=>x.id===id):null;
  const editing=!!p;
  const data=p||{name:"",type:"openai",baseUrl:"",apiKey:"",models:[],weight:50,timeout:60,maxRetries:2,dailyLimit:0,enabled:true};
  $("#content").insertAdjacentHTML("beforeend",'<div class="modal open" id="pmodal">'
    +'<div class="box"><h3>'+(editing?"编辑供应商":"新建供应商")+'</h3>'
    +'<div class="field"><label>名称</label><input id="f_name" value="'+esc(data.name)+'" style="width:100%"></div>'
    +'<div class="field"><label>类型</label><input id="f_type" value="'+esc(data.type)+'" style="width:100%" placeholder="openai / anthropic / google ..."></div>'
    +'<div class="field"><label>Base URL</label><input id="f_baseUrl" value="'+esc(data.baseUrl)+'" style="width:100%"></div>'
    +'<div class="field"><label>API Key</label><input id="f_apiKey" type="password" value="'+esc(data.apiKey)+'" style="width:100%" placeholder="留空则不修改"></div>'
    +'<div class="field"><label>模型（逗号分隔）</label><input id="f_models" value="'+esc((data.models||[]).join(","))+'" style="width:100%"></div>'
    +'<div style="display:flex;gap:12px">'
      +'<div class="field" style="flex:1"><label>权重</label><input id="f_weight" type="number" value="'+data.weight+'" style="width:100%"></div>'
      +'<div class="field" style="flex:1"><label>超时(秒)</label><input id="f_timeout" type="number" value="'+data.timeout+'" style="width:100%"></div>'
      +'<div class="field" style="flex:1"><label>每日限额</label><input id="f_dailyLimit" type="number" value="'+data.dailyLimit+'" style="width:100%"></div>'
    +'</div>'
    +'<div class="modal-actions"><button class="cancel" onclick="closeModal()">取消</button><button class="primary" onclick="saveProvider(\''+esc(id||"")+'\','+editing+')">保存</button></div>'
    +'</div></div>');
  $("#pmodal").addEventListener("click",e=>{if(e.target.id==="pmodal")closeModal();});
}
function closeModal(){const m=$("#pmodal");if(m)m.remove();}
async function saveProvider(id,editing){
  const models=$("#f_models").value.split(",").map(s=>s.trim()).filter(Boolean);
  const payload={
    name:$("#f_name").value.trim(),
    type:$("#f_type").value.trim()||"openai",
    baseUrl:$("#f_baseUrl").value.trim(),
    apiKey:$("#f_apiKey").value,
    models,
    weight:Number($("#f_weight").value)||0,
    timeout:Number($("#f_timeout").value)||60,
    dailyLimit:Number($("#f_dailyLimit").value)||0,
    enabled:true,
  };
  if(!payload.name){toast("请填写名称");return;}
  // 新建供应商必须标记为自定义，确保出现删除按钮
  if(!editing)payload.isCustom=true;
  try{
    const res=editing
      ?await fetchWithAuth("/providers/"+encodeURIComponent(id),{method:"PUT",body:JSON.stringify(payload)})
      :await fetchWithAuth("/providers",{method:"POST",body:JSON.stringify(payload)});
    if(!res.ok){const d=await res.json().catch(()=>({}));toast(d.error||"保存失败");return;}
    closeModal();
    await loadProviders();
    toast(editing?"已更新":"已创建");
  }catch(e){toast("保存失败："+e.message);}
}
async function deleteProvider(id){
  const p=providers.find(x=>x.id===id);
  if(!p)return;
  if(p.builtin){toast("内置供应商不可删除");return;}
  if(!confirm("确定删除「"+p.name+"」？"))return;
  try{const r=await fetchWithAuth("/providers/"+encodeURIComponent(id),{method:"DELETE"});if(r.ok){await loadProviders();toast("已删除");}else{const d=await r.json().catch(()=>({}));toast(d.error||"删除失败");}}catch(e){toast("删除失败："+e.message);}
}
async function loadProviders(){providers=await (await fetchWithAuth("/providers")).json();renderProviders();}

function renderRoutes(){
  $("#content").innerHTML='<div class="card"><div class="toolbar"><h3 style="margin:0">路由规则</h3><span class="spacer"></span><button class="primary" onclick="addRoute()">＋ 添加规则</button></div><div class="empty">暂无规则</div></div>';
}
function addRoute(){toast("路由规则编辑暂未实现");}

// 导航点击（事件委托）
$("#nav").addEventListener("click",e=>{const a=e.target.closest("a[data-tab]");if(a){loadTab(a.dataset.tab);if(innerWidth<=760)toggleSide();}});

// 初始化
(async function init(){
  const saved=localStorage.getItem("theme");
  const theme=saved||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
  document.documentElement.setAttribute("data-theme",theme);
  const btn=$("#themeBtn");if(btn)btn.textContent=theme==="dark"?"🌙":"☀️";
  try{const me=await (await fetchWithAuth("/auth/me")).json();if(!me.ok){location.href="/admin/login";return;}}catch(e){location.href="/admin/login";return;}
  await loadProviders();
  setActive("providers");
  // 同步版本号
  fetch("/health").then(r=>r.json()).then(d=>{if(d.version){const v=$("#ver");if(v)v.textContent="v"+d.version;}}).catch(()=>{});
})();
</script>
</body>
</html>`;

const LOGIN_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>irouter 登录</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--panel-2:#1c2030;--text:#e6e6e6;--muted:#8b93a3;--line:#2a2f3a;--accent:#6d8cff;--accent-2:#a06dff;--grad:linear-gradient(135deg,#6d8cff 0%,#a06dff 100%)}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"SF Pro","Segoe UI","PingFang SC",system-ui,sans-serif;background:radial-gradient(circle at 20% 10%,rgba(109,140,255,.18),transparent 40%),var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.box{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:36px 32px;width:min(380px,100%);box-shadow:0 24px 60px rgba(0,0,0,.5)}
.brand{font-size:24px;font-weight:800;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;text-align:center;margin-bottom:4px}
.sub{text-align:center;color:var(--muted);font-size:13px;margin-bottom:26px}
label{display:block;font-size:12px;color:var(--muted);margin:12px 0 5px;font-weight:600}
input{width:100%;padding:11px 14px;background:var(--panel-2);border:1px solid var(--line);border-radius:11px;color:var(--text);font-size:14px;outline:none}
input:focus{border-color:var(--accent)}
button{width:100%;margin-top:22px;padding:12px;background:var(--grad);color:#fff;border:none;border-radius:11px;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 6px 18px rgba(109,140,255,.4);transition:transform .1s}
button:active{transform:scale(.97)}
.err{color:#ff6b6b;font-size:13px;margin-top:14px;text-align:center;min-height:1.2em}
.ver{text-align:center;font-size:11px;color:var(--muted);margin-top:20px}
</style>
</head>
<body>
<div class="box">
  <div class="brand">⚡ irouter</div>
  <div class="sub">智能供应商路由 · 管理后台</div>
  <label>用户名</label>
  <input id="u" placeholder="admin" value="admin" autocomplete="username">
  <label>密码</label>
  <input id="p" type="password" placeholder="请输入密码" autocomplete="current-password">
  <button onclick="login()">登 录</button>
  <div class="err" id="e"></div>
  <div class="ver">v{{VERSION}}</div>
</div>
<script>
async function login(){
  const e=$("#e");e.textContent="";
  const r=await fetch("/admin/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u.value,password:p.value})});
  const d=await r.json().catch(()=>({}));
  if(d.ok){location.href="/";}else{e.textContent=d.error||"登录失败";}
}
document.getElementById("p").addEventListener("keydown",e=>{if(e.key==="Enter")login();});
</script>
</body>
</html>`;

// 本地直接运行（deno run main.ts）
if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") || "8000");
  console.log(`irouter v${VERSION} listening on :${port}`);
  Deno.serve({ port }, app.fetch);
}

export { app };
