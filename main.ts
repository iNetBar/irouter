// iRouter v2.5.1 — LLM 统一网关 / 管理后台后端 (Deno + Hono)
// 部署：Deno Deploy，需启用 Deno KV。入口文件：src/main.ts（或按平台设为 main.ts）
import { Hono } from 'https://deno.land/x/hono@v4.13.7/mod.ts';
import { serveStatic } from 'https://deno.land/x/hono@v4.13.7/middleware.ts';
// @ts-ignore - deno 标准库
import { crypto } from 'https://deno.land/std@0.224.0/crypto/mod.ts';

/* ============================ 类型 ============================ */
interface Provider {
  id: string; name: string; baseUrl: string; protocol: 'openai' | 'anthropic' | 'gemini';
  isCustom: boolean; rpm: number; enabled: boolean; models?: string[];
}
interface RouteRule {
  id: string; priority: number; pattern: string; providers: string[]; fallback?: string;
}
interface ApiKey { id: string; providerId: string; key: string; note?: string; enabled: boolean; failCount: number; }
interface Config {
  proxyKey?: string; timeout: number; cors: string; providers: Provider[];
}
interface ReqLog { time: string; model: string; provider: string; ok: boolean; latency: number; ratelimited?: boolean; }

const VERSION = '2.5.1';

/* ============================ KV ============================ */
let KV: Deno.Kv | null = null;
try { KV = await Deno.openKv(); } catch (e) { console.warn('[kv] unavailable, running in memory mode:', (e as Error).message); }

// 兼容各 Deno 版本的 Deno.Kv 类型
type KvKey = readonly unknown[];

function safeJson(v: unknown): any {
  return JSON.parse(JSON.stringify(v, (_k, val) => {
    if (val === undefined || typeof val === 'function' || typeof val === 'symbol') return undefined;
    if (val instanceof Date) return val.toISOString();
    if (val instanceof Map) return Object.fromEntries(val.entries());
    if (val instanceof Set) return Array.from(val);
    return val;
  }));
}
async function kvGet<T = unknown>(key: KvKey, fallback: T): Promise<T> {
  if (!KV) return fallback;
  try { const r = await KV.get(key); return (r?.value as T) ?? fallback; } catch (e) { console.error('[kv.get]', e); return fallback; }
}
async function kvSet(key: KvKey, value: unknown): Promise<void> {
  if (!KV) return; // 内存模式静默（前端会用本地数据兜底）
  try { await KV.set(key, safeJson(value)); } catch (e) { console.error('[kv.set]', e); }
}
async function kvDelete(key: KvKey): Promise<void> {
  if (!KV) return;
  try { await KV.delete(key); } catch (e) { console.error('[kv.delete]', e); }
}

/* ============================ 持久化存储 ============================ */
const STORES = {
  providers: { key: ['providers'] as KvKey, data: [] as Provider[] },
  routes: { key: ['routes'] as KvKey, data: [] as RouteRule[] },
  config: { key: ['config'] as KvKey, data: { timeout: 60, cors: '*' } as Config },
  keys: { key: ['keys'] as KvKey, data: [] as ApiKey[] },
  reqlog: { key: ['reqlog'] as KvKey, data: [] as ReqLog[] },
  latency: { key: ['latency'] as KvKey, data: {} as Record<string, number[]> },
};

async function loadAll() {
  const [providers, routes, config, keys, reqlog, latency] = await Promise.all([
    kvGet<Provider[]>(['providers'], []),
    kvGet<RouteRule[]>(['routes'], []),
    kvGet<Config>(['config'], { timeout: 60, cors: '*' }),
    kvGet<ApiKey[]>(['keys'], []),
    kvGet<ReqLog[]>(['reqlog'], []),
    kvGet<Record<string, number[]>>(['latency'], {}),
  ]);
  STORES.providers.data = Array.isArray(providers) ? providers : [];
  STORES.routes.data = Array.isArray(routes) ? routes : [];
  STORES.config.data = config && typeof config === 'object' ? config : { timeout: 60, cors: '*' };
  STORES.keys.data = Array.isArray(keys) ? keys : [];
  STORES.reqlog.data = Array.isArray(reqlog) ? reqlog.slice(-500) : [];
  STORES.latency.data = latency && typeof latency === 'object' ? latency : {};
}
async function persist(store: keyof typeof STORES) {
  await kvSet(STORES[store].key, STORES[store].data);
}

/* ============================ 错误包装 ============================ */
function errRes(msg: string, status = 500) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { 'content-type': 'application/json' } });
}
async function guarded<T>(req: Request, fn: () => Promise<T>): Promise<Response> {
  try { return await fn(); } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error('[admin api error]', new URL(req.url).pathname, msg);
    return errRes(msg, 500);
  }
}

/* ============================ 工具 ============================ */
function uid(prefix: string) { return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`; }
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

const DEFAULT_PROVIDERS: Provider[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai', isCustom: false, rpm: 0, enabled: true, models: ['gpt-5', 'gpt-5-mini', 'gpt-4o'] },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic', isCustom: false, rpm: 0, enabled: true, models: ['claude-opus-4', 'claude-sonnet-4'] },
  { id: 'google', name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com/v1', protocol: 'gemini', isCustom: false, rpm: 0, enabled: true, models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
];

async function ensureDefaults() {
  if (STORES.providers.data.length === 0) {
    STORES.providers.data = clone(DEFAULT_PROVIDERS);
    await persist('providers');
  }
  if (!STORES.config.data || typeof STORES.config.data !== 'object') STORES.config.data = { timeout: 60, cors: '*' };
}

/* ============================ Hono 应用 ============================ */
const app = new Hono();

// ---------- 静态前台（登录页 / 管理页） ----------
app.get('/admin/login', (c) => c.html(LOGIN_HTML));
app.get('/admin', (c) => c.redirect('/admin/'));
app.get('/admin/*', serveStatic({ root: './' }));

// ---------- 会话（极简，生产请替换为真 Session） ----------
const SESSIONS = new Map<string, { user: string; exp: number }>();
function makeSession(): string {
  const token = uid('sess');
  SESSIONS.set(token, { user: 'admin', exp: Date.now() + 8 * 3600 * 1000 });
  return token;
}
function getSession(req: Request): string | null {
  const h = req.headers.get('cookie') || '';
  const m = h.match(/irouter_sess=([^;]+)/);
  if (!m) return null;
  const s = SESSIONS.get(m[1]);
  if (!s || s.exp < Date.now()) { SESSIONS.delete(m[1]); return null; }
  return m[1];
}
function setCookie(res: Response, token: string) {
  res.headers.append('set-cookie', `irouter_sess=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${8 * 3600}`);
}

/* ================= 公开 API ================= */
app.post('/admin/api/login', async (c) => guarded(c.req.raw, async () => {
  const b = await c.req.json().catch(() => ({})) as { pass?: string };
  const envPass = Deno.env.get('DEFAULT_ADMIN_PASS') || 'admin123';
  if (!b.pass || b.pass !== envPass) return errRes('密码错误', 401);
  const token = makeSession();
  const res = new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  setCookie(res, token);
  return res;
}));

/* ================= 管理 API（需登录） ================= */
function adminGuard(req: Request): Response | null {
  if (!getSession(req)) return errRes('未登录', 401);
  return null;
}

app.get('/admin/api/logout', (c) => {
  const h = c.req.header('cookie') || '';
  const m = h.match(/irouter_sess=([^;]+)/);
  if (m) SESSIONS.delete(m[1]);
  const res = new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  res.headers.append('set-cookie', 'irouter_sess=; Path=/; HttpOnly; Max-Age=0');
  return res;
});

app.get('/admin/api/me', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  return Response.json({ ok: true, user: 'admin', version: VERSION });
}));

/* ---- 供应商 ---- */
app.get('/admin/api/providers', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  return Response.json(STORES.providers.data);
}));
app.post('/admin/api/providers', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  const b = await c.req.json() as Partial<Provider>;
  if (!b.id || !b.name) return errRes('id 和 name 必填', 400);
  if (STORES.providers.data.find(p => p.id === b.id)) return errRes('标识已存在', 409);
  const item: Provider = {
    id: String(b.id), name: String(b.name), baseUrl: String(b.baseUrl || ''),
    protocol: (b.protocol as Provider['protocol']) || 'openai',
    isCustom: !!b.isCustom, rpm: Number(b.rpm) || 0, enabled: b.enabled !== false,
    models: Array.isArray(b.models) ? b.models : [],
  };
  STORES.providers.data.push(item);
  await persist('providers');
  return Response.json(item, { status: 201 });
}));
app.put('/admin/api/providers/:id', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  const id = c.req.param('id');
  const b = await c.req.json() as Partial<Provider>;
  const i = STORES.providers.data.findIndex(p => p.id === id);
  if (i < 0) return errRes('供应商不存在', 404);
  STORES.providers.data[i] = { ...STORES.providers.data[i], ...b, id } as Provider;
  await persist('providers');
  return Response.json(STORES.providers.data[i]);
}));
app.delete('/admin/api/providers/:id', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  const id = c.req.param('id');
  if (!STORES.providers.data.find(p => p.id === id)) return errRes('供应商不存在', 404);
  STORES.providers.data = STORES.providers.data.filter(p => p.id !== id);
  await persist('providers');
  return Response.json({ ok: true });
}));

/* ---- Keys ---- */
app.get('/admin/api/providers/:id/keys', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  const id = c.req.param('id');
  return Response.json(STORES.keys.data.filter(k => k.providerId === id).map(k => ({ ...k, key: maskKey(k.key) })));
}));
app.post('/admin/api/providers/:id/keys', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  const providerId = c.req.param('id');
  if (!STORES.providers.data.find(p => p.id === providerId)) return errRes('供应商不存在', 404);
  const b = await c.req.json() as Partial<ApiKey>;
  if (!b.key) return errRes('key 必填', 400);
  const item: ApiKey = { id: uid('key'), providerId, key: String(b.key), note: b.note || '', enabled: true, failCount: 0 };
  STORES.keys.data.push(item);
  await persist('keys');
  return Response.json({ ...item, key: maskKey(item.key) }, { status: 201 });
}));
app.put('/admin/api/providers/:id/keys/:keyId', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  const { id, keyId } = c.req.param();
  const b = await c.req.json() as Partial<ApiKey>;
  const k = STORES.keys.data.find(x => x.id === keyId && x.providerId === id);
  if (!k) return errRes('Key 不存在', 404);
  if (b.note !== undefined) k.note = String(b.note);
  if (b.enabled !== undefined) k.enabled = !!b.enabled;
  if (b.failCount !== undefined) k.failCount = Number(b.failCount) || 0;
  await persist('keys');
  return Response.json({ ...k, key: maskKey(k.key) });
}));
app.delete('/admin/api/providers/:id/keys/:keyId', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  const { id, keyId } = c.req.param();
  STORES.keys.data = STORES.keys.data.filter(x => !(x.id === keyId && x.providerId === id));
  await persist('keys');
  return Response.json({ ok: true });
}));
function maskKey(k: string): string { if (!k) return ''; if (k.length <= 10) return '****'; return k.slice(0, 6) + '…' + k.slice(-4); }

/* ---- 路由规则 ---- */
app.get('/admin/api/routes', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  return Response.json(STORES.routes.data.slice().sort((a, b) => (a.priority || 100) - (b.priority || 100)));
}));
app.post('/admin/api/routes', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  const b = await c.req.json() as Partial<RouteRule>;
  if (!b.pattern && b.pattern !== '') return errRes('pattern 必填', 400);
  if (!Array.isArray(b.providers) || !b.providers.length) return errRes('providers 至少一项', 400);
  const item: RouteRule = {
    id: b.id || uid('r'),
    priority: Number(b.priority) || 100,
    pattern: String(b.pattern === undefined ? '*' : b.pattern),
    providers: b.providers as string[],
    fallback: b.fallback || undefined,
  };
  STORES.routes.data.push(item);
  await persist('routes');
  return Response.json(item, { status: 201 });
}));
app.put('/admin/api/routes/:id', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  const id = c.req.param('id');
  const b = await c.req.json() as Partial<RouteRule>;
  const i = STORES.routes.data.findIndex(r => r.id === id);
  if (i < 0) return errRes('规则不存在', 404);
  STORES.routes.data[i] = { ...STORES.routes.data[i], ...b, id } as RouteRule;
  await persist('routes');
  return Response.json(STORES.routes.data[i]);
}));
app.delete('/admin/api/routes/:id', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  const id = c.req.param('id');
  STORES.routes.data = STORES.routes.data.filter(r => r.id !== id);
  await persist('routes');
  return Response.json({ ok: true });
}));

/* ---- 配置 ---- */
app.get('/admin/api/config', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  return Response.json(STORES.config.data);
}));
app.put('/admin/api/config', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  const b = await c.req.json() as Partial<Config>;
  STORES.config.data = {
    ...STORES.config.data,
    proxyKey: b.proxyKey !== undefined ? b.proxyKey : STORES.config.data.proxyKey,
    timeout: Number(b.timeout) || STORES.config.data.timeout || 60,
    cors: b.cors !== undefined ? String(b.cors) : STORES.config.data.cors,
  };
  await persist('config');
  return Response.json(STORES.config.data);
}));

/* ---- 存储状态（真实可写探测） ---- */
app.get('/admin/api/storage/status', (c) => guarded(c.req.raw, async () => {
  if (!KV) return Response.json({ mode: 'memory', writable: false, warning: 'Deno KV 未启用，数据仅存内存，重启会丢失。请在 Deno Deploy → Settings → Deno KV 启用。' });
  try {
    const probe: KvKey = ['__probe__', Date.now(), Math.random()];
    await KV.set(probe, { ok: true, t: Date.now() });
    await KV.delete(probe);
    return Response.json({ mode: 'kv', writable: true });
  } catch (e) {
    return Response.json({ mode: 'memory', writable: false, warning: 'KV 不可用：' + (e instanceof Error ? e.message : String(e)) });
  }
}));

/* ================= ★ Dashboard 聚合接口（真实注册） ================= */
app.get('/admin/api/dashboard', (c) => guarded(c.req.raw, async () => {
  const auth = adminGuard(c.req.raw); if (auth) return auth;
  const providers = STORES.providers.data;
  const routes = STORES.routes.data;
  const keys = STORES.keys.data;
  const reqLog = STORES.reqlog.data;
  const latency = STORES.latency.data;

  const totalRequests = reqLog.length;
  const successCount = reqLog.filter(r => r.ok).length;
  const successRate = totalRequests ? Math.round((successCount / totalRequests) * 100) : 0;
  const allLat = reqLog.map(r => r.latency).filter(n => typeof n === 'number' && n >= 0);
  const avgLatency = allLat.length ? Math.round(allLat.reduce((a, b) => a + b, 0) / allLat.length) : 0;

  // 模型调用排行
  const modelCount = new Map<string, number>();
  for (const r of reqLog) modelCount.set(r.model, (modelCount.get(r.model) || 0) + 1);
  const modelRanking = Array.from(modelCount.entries())
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // 供应商健康度
  const providerHealth = providers.map(p => {
    const logs = reqLog.filter(r => r.provider === p.id);
    const success = logs.filter(r => r.ok).length;
    const total = logs.length;
    const lats = logs.map(r => r.latency).filter(n => typeof n === 'number' && n >= 0);
    const avg = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0;
    return { id: p.id, name: p.name, ok: total ? success / total >= 0.5 : true, total, success, avgLatency: avg };
  });

  // 最近请求
  const recentRequests = reqLog.slice(-20).reverse().map(r => ({
    time: r.time, model: r.model, provider: r.provider, ok: r.ok, latency: r.latency, ratelimited: !!r.ratelimited,
  }));

  // 存储状态
  let storage: { mode: 'kv' | 'memory'; writable: boolean; warning?: string } = { mode: 'memory', writable: false };
  if (KV) { try { const probe: KvKey = ['__probe__', Date.now()]; await KV.set(probe, { ok: true }); await KV.delete(probe); storage = { mode: 'kv', writable: true }; } catch (e) { storage = { mode: 'memory', writable: false, warning: (e as Error).message }; } }

  return Response.json({
    ok: true,
    data: {
      stats: { providers: providers.length, routes: routes.length, keys: keys.length, totalRequests, successRate, avgLatency },
      modelRanking, providerHealth, recentRequests, storage,
      system: { version: VERSION, mode: 'deno-deploy', kv: !!KV, persist: !!KV },
    },
  });
}));

/* ---- 请求日志写入（供 Dashboard 统计） ---- */
export function recordRequest(entry: ReqLog) {
  STORES.reqlog.data.push(entry);
  if (STORES.reqlog.data.length > 500) STORES.reqlog.data = STORES.reqlog.data.slice(-500);
  // 异步持久化，不阻塞响应
  persist('reqlog').catch(() => {});
  const arr = (STORES.latency.data[entry.model] = STORES.latency.data[entry.model] || []);
  arr.push(entry.latency);
  if (arr.length > 100) arr.shift();
  persist('latency').catch(() => {});
}

/* ================= 代理转发（/v1/*） ================= */
app.all('/v1/*', async (c) => {
  const cfg = STORES.config.data;
  const proxyKey = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (cfg.proxyKey && proxyKey !== cfg.proxyKey) return errRes('Unauthorized', 401);

  const body = await c.req.json().catch(() => ({})) as { model?: string; messages?: unknown };
  const model = String(body.model || '').trim();
  const rule = matchRoute(model);
  if (!rule) return errRes(`没有匹配的路由规则：${model || '(空 model)'}`, 404);

  const ordered = rule.providers.concat(rule.fallback ? [rule.fallback] : []);
  let lastErr: string | null = null;
  for (const pid of ordered) {
    const provider = STORES.providers.data.find(p => p.id === pid);
    if (!provider || provider.enabled === false) continue;
    const keys = STORES.keys.data.filter(k => k.providerId === pid && k.enabled !== false).sort((a, b) => a.failCount - b.failCount);
    if (!keys.length) { lastErr = `供应商 ${provider.name} 无可用 Key`; continue; }
    const key = keys[0];
    const start = Date.now();
    try {
      const upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout((cfg.timeout || 60) * 1000),
      });
      if (!upstream.ok) {
        key.failCount++;
        await persist('keys');
        lastErr = `${provider.name}: ${upstream.status}`;
        if (rule.fallback && pid !== rule.fallback) continue;
        return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' } });
      }
      const t = await upstream.text();
      recordRequest({ time: new Date().toISOString(), model, provider: pid, ok: true, latency: Date.now() - start });
      return new Response(t, { status: 200, headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' } });
    } catch (e) {
      key.failCount++;
      await persist('keys');
      lastErr = `${provider.name}: ${(e as Error).message}`;
      recordRequest({ time: new Date().toISOString(), model, provider: pid, ok: false, latency: Date.now() - start });
      if (pid === rule.fallback) break;
    }
  }
  return errRes(lastErr || '所有供应商均不可用', 502);
});

function matchRoute(model: string): RouteRule | null {
  const rules = STORES.routes.data.slice().sort((a, b) => (a.priority || 100) - (b.priority || 100));
  for (const r of rules) {
    if (r.pattern === '*' || r.pattern === '') return r;
    if (r.pattern.endsWith('*')) { const pre = r.pattern.slice(0, -1); if (model.startsWith(pre)) return r; }
    if (r.pattern === model) return r;
  }
  return null;
}

/* ================= 启动 ================= */
await loadAll();
await ensureDefaults();

// 自检：确认关键路由已注册（部署期即失败，避免运行时 404）
const REGISTERED = new Set(app.routes ? app.routes.map((r: any) => r.path).filter(Boolean) : []);
function assertRoute(path: string) { if (!REGISTERED.has(path)) console.error(`[FATAL] route not registered: ${path}`); }
assertRoute('/admin/api/providers');
assertRoute('/admin/api/routes');
assertRoute('/admin/api/dashboard');

console.log(`[irouter] v${VERSION} ready · providers=${STORES.providers.data.length} routes=${STORES.routes.data.length} kv=${!!KV}`);

Deno.serve({ port: Number(Deno.env.get('PORT')) || 8000 }, app.fetch);

/* ================= 登录页 HTML ================= */
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>iRouter 登录</title>
<style>
body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#0f1117;color:#e8eaed;
display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#171a23;border:1px solid #2a2f3a;border-radius:16px;padding:36px;width:360px}
h1{font-size:20px;margin:0 0 6px}.sub{color:#9aa0ac;font-size:13px;margin-bottom:22px}
input{width:100%;background:#1d212c;border:1px solid #2a2f3a;border-radius:10px;padding:12px;color:#fff;margin-bottom:14px;outline:none}
input:focus{border-color:#7c5cff}
button{width:100%;background:linear-gradient(135deg,#7c5cff,#a78bfa);border:none;border-radius:10px;padding:12px;color:#fff;font-weight:600;cursor:pointer}
.err{color:#ff453a;font-size:13px;margin-bottom:12px;min-height:18px}
</style></head><body>
<div class="box"><h1>🛡 iRouter</h1><p class="sub">LLM 统一网关管理后台</p>
<div class="err" id="err"></div>
<input type="password" id="pass" placeholder="管理密码" autofocus>
<button onclick="login()">登 录</button></div>
<script>
async function login(){
const p=document.getElementById('pass').value;
const r=await fetch('/admin/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pass:p})});
if(!r.ok){document.getElementById('err').textContent=(await r.json()).error||'登录失败';return;}
location.href='/admin/';
}
document.getElementById('pass').addEventListener('keydown',e=>{if(e.key==='Enter')login();});
</script></body></html>`;
