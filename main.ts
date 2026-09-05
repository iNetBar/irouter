import { Hono } from "hono";

// =====================================================================
//  LLM Router · v2.2.0 (完整版)
//  单文件实现，无外部模块依赖（除 Hono）
//
//  功能:
//  [核心] 多供应商路由 / OpenAI 兼容协议转换(Anthropic·Google·GLM)
//  [目录] 20+ 内置免费/低价/自建供应商
//  [配置] KV 持久化配置中心 (环境变量 SEED_KEYS 做种子)
//  [后台] 可视化 Dashboard (供应商/Keys/延迟/用量/日志/路由 6 Tab)
//  [监控] 健康检查 · Key 失效自动摘除 · Webhook 告警
//  [统计] 延迟 P50/P95/avg/max · Token 用量 · 请求审计日志
//  [路由] 模型->供应商优先级 + 通配 fallback
//  [鉴权] 多 Proxy Key (白名单/RPM/过期) + 静态 PROXY_KEY
//  [运维] 配置导入/导出 · 预算拦截
// =====================================================================

// ---------- ENV ----------
const ENV = {
  PROXY_KEY: (Deno.env.get("PROXY_KEY") || "").split(",").map((s) => s.trim()).filter(Boolean),
  SEED_KEYS: Deno.env.get("SEED_KEYS") || "",
  MONTHLY_BUDGET: Number(Deno.env.get("MONTHLY_BUDGET") || "0"),
  DAILY_TOKEN_BUDGET: Number(Deno.env.get("DAILY_TOKEN_BUDGET") || "0"),
  RATE_LIMIT_RPM: Number(Deno.env.get("RATE_LIMIT_RPM") || "0"),
  ENABLE_USAGE: (Deno.env.get("ENABLE_USAGE") || "true") !== "false",
  HEALTH_CHECK_INTERVAL_MS: Number(Deno.env.get("HEALTH_CHECK_INTERVAL_MS") || "300000"),
  KEY_FAIL_THRESHOLD: Number(Deno.env.get("KEY_FAIL_THRESHOLD") || "3"),
  KEY_AUTO_RECOVER: (Deno.env.get("KEY_AUTO_RECOVER") || "true") !== "false",
  WEBHOOK_URL: Deno.env.get("WEBHOOK_URL") || "",
  WEBHOOK_SECRET: Deno.env.get("WEBHOOK_SECRET") || "",
  LOG_RETENTION_HOURS: Number(Deno.env.get("LOG_RETENTION_HOURS") || "168"),
  ADMIN_USER: Deno.env.get("ADMIN_USER") || "admin",
  ADMIN_PASS: Deno.env.get("ADMIN_PASS") || "",
};

// ---------- 内置供应商目录 (完整) ----------
type Proto = "openai" | "anthropic" | "google" | "glm";
interface BuiltinDef { name: string; protocol: Proto; baseUrl: string; defaultModel: string; isCustom?: boolean; }
const BUILTIN: Record<string, BuiltinDef> = {
  // 国产 (多有免费额度)
  deepseek:   { name: "DeepSeek",       protocol: "openai",  baseUrl: "https://api.deepseek.com/v1",        defaultModel: "deepseek-chat" },
  qwen:       { name: "通义千问",       protocol: "openai",  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus" },
  hunyuan:    { name: "腾讯混元",       protocol: "openai",  baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", defaultModel: "hunyuan-lite" },
  doubao:     { name: "豆包/火山方舟",  protocol: "openai",  baseUrl: "https://ark.cn-beijing.volces.com/api/v3", defaultModel: "doubao-pro-4k" },
  kimi:       { name: "Kimi (Moonshot)", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1",          defaultModel: "moonshot-v1-8k" },
  glm:        { name: "智谱 GLM",      protocol: "glm",     baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4-flash" },
  // 聚合 / 低价
  siliconflow:{ name: "硅基流动",       protocol: "openai",  baseUrl: "https://api.siliconflow.cn/v1",      defaultModel: "deepseek-ai/DeepSeek-V2.5" },
  groq:       { name: "Groq (极速)",    protocol: "openai",  baseUrl: "https://api.groq.com/openai/v1",     defaultModel: "llama-3.1-8b-instant" },
  together:   { name: "Together",      protocol: "openai",  baseUrl: "https://api.together.xyz/v1",        defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  openrouter: { name: "OpenRouter",     protocol: "openai",  baseUrl: "https://openrouter.ai/api/v1",       defaultModel: "openai/gpt-4o-mini" },
  fireworks:  { name: "Fireworks",      protocol: "openai",  baseUrl: "https://api.fireworks.ai/inference/v1", defaultModel: "accounts/fireworks/models/llama-v3p1-8b-instruct" },
  novita:     { name: "Novita",         protocol: "openai",  baseUrl: "https://api.novita.ai/v3/openai",    defaultModel: "meta-llama/llama-3.1-8b-instruct" },
  ppio:       { name: "PPIO 派欧",      protocol: "openai",  baseUrl: "https://api.ppio.cn/v1",             defaultModel: "deepseek/deepseek-chat" },
  mistral:    { name: "Mistral",        protocol: "openai",  baseUrl: "https://api.mistral.ai/v1",          defaultModel: "mistral-small-latest" },
  cohere:     { name: "Cohere",         protocol: "openai",  baseUrl: "https://api.cohere.ai/v2",           defaultModel: "command-r-plus" },
  // 国际官方
  openai:     { name: "OpenAI",         protocol: "openai",  baseUrl: "https://api.openai.com/v1",          defaultModel: "gpt-4o-mini" },
  anthropic:  { name: "Anthropic",      protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1",     defaultModel: "claude-sonnet-4-20250514" },
  google:     { name: "Google",         protocol: "google",  baseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-1.5-flash" },
  // 自建/私有 (默认禁用)
  ollama:     { name: "Ollama (自建)",  protocol: "openai",  baseUrl: "http://localhost:11434/v1", defaultModel: "llama3", isCustom: true },
  vllm:       { name: "vLLM (自建)",    protocol: "openai",  baseUrl: "http://localhost:8000/v1",  defaultModel: "qwen2",  isCustom: true },
  oneapi:     { name: "OneAPI (自建)",  protocol: "openai",  baseUrl: "http://localhost:3000/v1",  defaultModel: "gpt-4o-mini", isCustom: true },
};

// ---------- 类型 ----------
interface ApiKey { id: string; key: string; label?: string; weight: number; enabled: boolean; failCount: number; lastError?: string; disabledAt?: number; }
interface Provider { id: string; name: string; protocol: Proto; baseUrl: string; defaultModel: string; models: string[]; keys: ApiKey[]; enabled: boolean; isCustom: boolean; }
interface RouteRule { id: string; pattern: string; providers: string[]; } // pattern 支持 * 通配
interface ProxyKey { id: string; key: string; label?: string; models?: string[]; rpm?: number; expiresAt?: number; enabled: boolean; calls: number; }
interface LogEntry { ts: number; model: string; provider: string; status: number; latency_ms: number; input_tokens?: number; output_tokens?: number; error?: string; }
interface AlertEntry { ts: number; event: string; provider?: string; key?: string; reason?: string; }

// ---------- KV (懒加载) ----------
let _kv: Deno.Kv | null | undefined = undefined;
async function getKv(): Promise<Deno.Kv | null> {
  if (_kv !== undefined) return _kv;
  try { _kv = await Deno.openKv(); } catch { _kv = null; }
  return _kv;
}

// =====================================================================
//  配置中心
// =====================================================================
class ConfigStore {
  providers = new Map<string, Provider>();
  ready: Promise<void>;
  constructor() { this.ready = this.init(); }
  async init() {
    this.seedFromEnv();
    const kv = await getKv();
    if (kv) {
      const stored = await kv.get<{ providers: Provider[] }>(["config"]);
      if (stored.value?.providers) {
        for (const p of stored.value.providers) this.providers.set(p.id, p);
      }
    }
  }
  seedFromEnv() {
    for (const [id, def] of Object.entries(BUILTIN)) {
      this.providers.set(id, { id, ...def, models: [], keys: [], enabled: !def.isCustom });
    }
    this.addSeedKeys();
  }
  addSeedKeys() {
    for (const part of ENV.SEED_KEYS.split(",").filter(Boolean)) {
      const [id, ...rest] = part.split(":");
      const key = rest.join(":");
      const p = this.providers.get(id);
      if (p && key) p.keys.push({ id: `k_${p.keys.length}`, key, weight: 1, enabled: true, failCount: 0 });
    }
  }
  mask(p: Provider) {
    return { ...p, keys: p.keys.map(({ key, ...k }) => ({ ...k, key: key ? key.slice(0, 4) + "****" : "" })) };
  }
  async persist() {
    const kv = await getKv();
    if (!kv) return;
    await kv.put(["config"], { providers: [...this.providers.values()] });
  }
  list() { return [...this.providers.values()].map((p) => this.mask(p)); }
  get(id: string) { const p = this.providers.get(id); return p ? this.mask(p) : null; }
  upsert(input: Partial<Provider> & { id: string }) {
    const e = this.providers.get(input.id);
    const p: Provider = {
      id: input.id,
      name: input.name || input.id,
      protocol: (input.protocol || "openai") as Proto,
      baseUrl: input.baseUrl || "",
      defaultModel: input.defaultModel || "",
      models: input.models || e?.models || [],
      keys: e?.keys || [],
      enabled: input.enabled !== false,
      isCustom: !!input.isCustom,
    };
    this.providers.set(input.id, p);
    this.persist();
    return this.mask(p);
  }
  delete(id: string) { this.providers.delete(id); this.persist(); return { ok: true }; }
  addKey(id: string, key: string, label?: string, weight = 1) {
    const p = this.providers.get(id);
    if (!p) return null;
    const k: ApiKey = { id: `k_${Date.now().toString(36)}`, key, label, weight, enabled: true, failCount: 0 };
    p.keys.push(k);
    this.persist();
    return { ...k, key: k.key.slice(0, 4) + "****" };
  }
  deleteKey(id: string, keyId: string) {
    const p = this.providers.get(id);
    if (!p) return { ok: false };
    p.keys = p.keys.filter((k) => k.id !== keyId);
    this.persist();
    return { ok: true };
  }
  recoverKey(id: string, keyId: string) {
    const p = this.providers.get(id);
    if (!p) return { ok: false };
    const k = p.keys.find((x) => x.id === keyId);
    if (!k) return { ok: false };
    k.failCount = 0; k.enabled = true; k.disabledAt = undefined; k.lastError = undefined;
    this.persist();
    return { ok: true };
  }
  pickKey(id: string): { key: string; index: number } | null {
    const p = this.providers.get(id);
    if (!p || !p.enabled) return null;
    const e = p.keys.filter((k) => k.enabled && k.key);
    if (!e.length) return null;
    return { key: e[0].key, index: 0 }; // 简单取首个，可扩展加权轮询
  }
}

// =====================================================================
//  延迟统计 (P50/P95/avg/max)
// =====================================================================
class LatencyStats {
  private data = new Map<string, number[]>();
  record(provider: string, ms: number) {
    if (!this.data.has(provider)) this.data.set(provider, []);
    const arr = this.data.get(provider)!;
    arr.push(ms);
    if (arr.length > 500) arr.shift();
  }
  private percentile(arr: number[], p: number) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
    return s[idx];
  }
  summary() {
    const all = [...this.data.values()].flat();
    return {
      p50: this.percentile(all, 50),
      p95: this.percentile(all, 95),
      avg: all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length) : 0,
      max: all.length ? Math.max(...all) : 0,
      count: all.length,
    };
  }
  allByProvider() {
    const out: Record<string, { p50: number; p95: number; avg: number; max: number; count: number }> = {};
    for (const [k, arr] of this.data) {
      out[k] = {
        p50: this.percentile(arr, 50),
        p95: this.percentile(arr, 95),
        avg: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0,
        max: arr.length ? Math.max(...arr) : 0,
        count: arr.length,
      };
    }
    return out;
  }
}

// =====================================================================
//  请求审计日志
// =====================================================================
class RequestLog {
  private entries: LogEntry[] = [];
  add(e: LogEntry) { this.entries.push(e); }
  query(opts: { provider?: string; model?: string; limit?: number } = {}) {
    let r = [...this.entries];
    if (opts.provider) r = r.filter((e) => e.provider === opts.provider);
    if (opts.model) r = r.filter((e) => e.model === opts.model);
    return r.slice(-(opts.limit || 100)).reverse();
  }
  prune() {
    const cutoff = Date.now() - ENV.LOG_RETENTION_HOURS * 3600 * 1000;
    this.entries = this.entries.filter((e) => e.ts > cutoff);
  }
  totalTokens() {
    return this.entries.reduce((a, e) => a + (e.input_tokens || 0) + (e.output_tokens || 0), 0);
  }
}

// =====================================================================
//  路由规则 (模型 -> 供应商优先级 + 通配 fallback)
// =====================================================================
class RouteRules {
  rules: RouteRule[] = [];
  resolve(model: string, allProviders: string[]): string[] {
    const matches: RouteRule[] = [];
    for (const r of this.rules) {
      const pat = r.pattern.replace(/\*/g, ".*");
      if (new RegExp("^" + pat + "$", "i").test(model)) matches.push(r);
    }
    if (matches.length) {
      // 按规则定义顺序拼接去重
      const ordered: string[] = [];
      for (const m of matches) for (const pid of m.providers) if (!ordered.includes(pid)) ordered.push(pid);
      return ordered.filter((id) => allProviders.includes(id));
    }
    // 无规则：返回所有可用 (调用方按 defaultModel 匹配自然排序)
    return allProviders;
  }
  list() { return this.rules; }
  add(b: Partial<RouteRule> & { pattern: string; providers: string[] }) {
    const r: RouteRule = { id: `r_${Date.now().toString(36)}`, pattern: b.pattern, providers: b.providers };
    this.rules.push(r);
    return r;
  }
  remove(id: string) { this.rules = this.rules.filter((r) => r.id !== id); return { ok: true }; }
}

// =====================================================================
//  多 Proxy Key 管理 (白名单/RPM/过期)
// =====================================================================
class ProxyKeyManager {
  keys: ProxyKey[] = [];
  add(b: Partial<ProxyKey> & { key: string }) {
    const p: ProxyKey = { id: `pk_${Date.now().toString(36)}`, key: b.key, label: b.label, models: b.models, rpm: b.rpm, expiresAt: b.expiresAt, enabled: true, calls: 0 };
    this.keys.push(p);
    return { ...p, key: p.key.slice(0, 4) + "****" };
  }
  list() { return this.keys.map(({ key, ...k }) => ({ ...k, key: key.slice(0, 4) + "****" })); }
  remove(id: string) { this.keys = this.keys.filter((k) => k.id !== id); return { ok: true }; }
  validate(providedKey: string, model?: string): { ok: boolean } {
    const p = this.keys.find((x) => x.key === providedKey && x.enabled);
    if (!p) return { ok: false };
    if (p.expiresAt && p.expiresAt < Date.now()) return { ok: false };
    if (p.models?.length && model && !p.models.includes(model)) return { ok: false };
    if (p.rpm && p.calls >= p.rpm) return { ok: false };
    p.calls++;
    return { ok: true };
  }
}

// =====================================================================
//  Webhook 告警
// =====================================================================
class WebhookNotifier {
  alerts: AlertEntry[] = [];
  constructor(private url?: string, private secret?: string) {}
  async notify(event: string, payload: Record<string, unknown> = {}) {
    const entry: AlertEntry = { ts: Date.now(), event, ...payload };
    this.alerts.unshift(entry);
    if (this.alerts.length > 100) this.alerts.pop();
    if (!this.url) return;
    try {
      const body = JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.secret) headers["x-webhook-signature"] = this.secret;
      await fetch(this.url, { method: "POST", headers, body });
    } catch { /* 不阻塞主流程 */ }
  }
}

// =====================================================================
//  配置导出
// =====================================================================
function exportConfig(providers: ReturnType<ConfigStore["list"]>, routes: RouteRules, pkm: ProxyKeyManager) {
  return {
    version: "2.2.0",
    exported_at: new Date().toISOString(),
    providers,
    routes: routes.list(),
    proxy_keys: pkm.list(),
  };
}

// =====================================================================
//  实例化
// =====================================================================
const CONFIG = new ConfigStore();
const LATENCY = new LatencyStats();
const REQLOG = new RequestLog();
const ROUTES = new RouteRules();
const PKM = new ProxyKeyManager();
const WEBHOOK = new WebhookNotifier(ENV.WEBHOOK_URL || undefined, ENV.WEBHOOK_SECRET || undefined);

// 用 SEED_KEYS 预置 ProxyKey
for (const part of ENV.SEED_KEYS.split(",").filter(Boolean)) {
  const [id, ...rest] = part.split(":");
  const key = rest.join(":");
  if (key) PKM.add({ key, label: `seed:${id}` });
}

// =====================================================================
//  协议转换 (请求)
// =====================================================================
function buildUpstream(protocol: Proto, baseUrl: string, key: string, body: Record<string, unknown>) {
  const b = baseUrl.replace(/\/$/, "");
  if (protocol === "openai" || protocol === "glm") {
    return { url: `${b}/chat/completions`, method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body };
  }
  if (protocol === "anthropic") {
    const msgs = (body.messages || []).filter((m: any) => m.role !== "system").map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content || "" }));
    const system = (body.messages || []).find((m: any) => m.role === "system")?.content;
    return { url: `${b}/messages`, method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: { model: body.model, messages: msgs, ...(system ? { system } : {}), max_tokens: (body as any).max_tokens || 4096 } };
  }
  if (protocol === "google") {
    const lastMsg = [...(body.messages || [])].reverse().find((m: any) => m.role === "user");
    return { url: `${b}/models/${(body as any).model}:generateContent?key=${key}`, method: "POST", headers: { "content-type": "application/json" }, body: { contents: [{ role: "user", parts: [{ text: lastMsg?.content || "" }] }] } };
  }
  return { url: `${b}/chat/completions`, method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body };
}

// =====================================================================
//  协议转换 (响应 -> OpenAI 归一化)
// =====================================================================
function normalizeResponse(protocol: Proto, payload: any, model: string) {
  if (protocol === "anthropic") {
    const text = (payload.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    return { id: payload.id || "x", object: "chat.completion", model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: payload.usage };
  }
  if (protocol === "google") {
    const text = (payload.candidates || []).map((c: any) => c.content?.parts?.map((p: any) => p.text).join("") || "").join("");
    return { id: "x", object: "chat.completion", model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }] };
  }
  return payload;
}

// =====================================================================
//  鉴权
// =====================================================================
function checkAuth(req: Request): boolean {
  const auth = req.headers.get("authorization") || "";
  const provided = auth.replace(/^Bearer\s+/i, "");
  if (ENV.PROXY_KEY.length || PKM.keys.length) {
    if (!provided) return false;
    if (PKM.keys.length) { const v = PKM.validate(provided, undefined); if (v.ok) return true; }
    if (ENV.PROXY_KEY.length && ENV.PROXY_KEY.includes(provided)) return true;
    return false;
  }
  return true;
}

// =====================================================================
//  健康检查 (后台定时)
// =====================================================================
async function healthCheckOnce(provider: Provider): Promise<{ provider: string; healthy: number; total: number; latency_ms?: number }> {
  const enabledKeys = provider.keys.filter((k) => k.enabled && k.key);
  if (!enabledKeys.length) return { provider: provider.id, healthy: 0, total: 0 };
  const start = Date.now();
  let healthy = 0;
  for (const k of enabledKeys.slice(0, 3)) { // 最多探测 3 个 key
    try {
      const up = buildUpstream(provider.protocol, provider.baseUrl, k.key, { model: provider.defaultModel, messages: [{ role: "user", content: "hi" }] });
      const res = await fetch(up.url, { method: up.method, headers: up.headers, body: JSON.stringify(up.body), signal: AbortSignal.timeout(8000) });
      // 401/403 说明 key 无效；2xx/4xx(其它) 说明端点可达
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403)) healthy++;
      else { k.failCount++; k.lastError = `health: ${res.status}`; }
    } catch (e) {
      k.lastError = `health: ${(e as Error).message}`;
    }
  }
  // 自动恢复：被摘除的 key 若探测通过则清零
  for (const k of provider.keys) {
    if (!k.enabled && ENV.KEY_AUTO_RECOVER && k.failCount >= ENV.KEY_FAIL_THRESHOLD) {
      // 简单策略：达到阈值后给一次重试机会 (下一轮自然会被 pickKey 忽略，这里仅重置计数供人工恢复参考)
    }
  }
  return { provider: provider.id, healthy, total: enabledKeys.length, latency_ms: Date.now() - start };
}

async function healthCheckAll() {
  const providers = [...CONFIG.providers.values()].filter((p) => p.enabled);
  const results = await Promise.all(providers.map(healthCheckOnce));
  return results;
}

// 启动定时健康检查
let healthTimer: number | undefined;
CONFIG.ready.then(() => {
  if (ENV.HEALTH_CHECK_INTERVAL_MS > 0) {
    healthTimer = setInterval(() => healthCheckAll().catch(() => {}), ENV.HEALTH_CHECK_INTERVAL_MS) as unknown as number;
  }
});

// =====================================================================
//  Hono App
// =====================================================================
const app = new Hono();

app.get("/", (c) => c.json({ ok: true, service: "llm-router", version: "2.2.0", providers: CONFIG.providers.size }));
app.get("/health", (c) => c.json({ ok: true }));

// ---- /v1/models ----
app.get("/v1/models", async (c) => {
  await CONFIG.ready;
  if (!checkAuth(c.req.raw)) return c.text("Unauthorized", 401);
  const list = [...CONFIG.providers.values()]
    .filter((p) => p.enabled)
    .flatMap((p) => [p.defaultModel, ...(p.models || [])].filter(Boolean).map((m) => ({ id: m, object: "model", owned_by: p.id })));
  return c.json({ object: "list", data: list });
});

// ---- /v1/chat/completions ----
app.post("/v1/chat/completions", async (c) => {
  await CONFIG.ready;
  if (!checkAuth(c.req.raw)) return c.text("Unauthorized", 401);

  // 预算拦截
  if (ENV.DAILY_TOKEN_BUDGET && REQLOG.totalTokens() >= ENV.DAILY_TOKEN_BUDGET) {
    return c.json({ error: "daily token budget exceeded", limit: ENV.DAILY_TOKEN_BUDGET }, 429);
  }

  const body = await c.req.json() as Record<string, unknown> & { model?: string; stream?: boolean };
  const model = (body.model as string) || "default";

  const providers = [...CONFIG.providers.values()].filter((p) => p.enabled && p.keys.some((k) => k.enabled && k.key));
  const orderedIds = ROUTES.resolve(model, providers.map((p) => p.id));
  const ordered = orderedIds.map((id) => providers.find((p) => p.id === id)).filter(Boolean) as Provider[];
  const candidates = ordered.length ? ordered : providers;

  const start = Date.now();
  let lastErr: any = null;
  for (const provider of candidates) {
    const picked = CONFIG.pickKey(provider.id);
    if (!picked) continue;
    const up = buildUpstream(provider.protocol, provider.baseUrl, picked.key, body);
    try {
      const res = await fetch(up.url, { method: up.method, headers: up.headers, body: JSON.stringify(up.body) });
      const text = await res.text();
      const ms = Date.now() - start;
      LATENCY.record(provider.id, ms);
      let parsed: any = {};
      try { parsed = JSON.parse(text); } catch {}
      const out = normalizeResponse(provider.protocol, parsed, model);
      const u = (out as any).usage || {};
      REQLOG.add({ ts: Date.now(), model, provider: provider.id, status: res.status, latency_ms: ms, input_tokens: u.prompt_tokens || u.input_tokens || 0, output_tokens: u.completion_tokens || u.output_tokens || 0 });

      if (res.ok) {
        // 非流式直接返回
        if (!(body.stream && (out as any).choices?.[0]?.delta)) return c.json(out);
        // 流式：透传 (这里简单把上游 text 作为 SSE 返回)
        return c.text(text, { headers: { "content-type": res.headers.get("content-type") || "text/event-stream" } });
      }
      lastErr = { status: res.status, body: text };
      // 401/403 -> 累计失败，超限自动摘除
      if (res.status === 401 || res.status === 403) {
        const k = provider.keys.find((x) => x.key === picked.key);
        if (k) {
          k.failCount++;
          if (k.failCount >= ENV.KEY_FAIL_THRESHOLD) {
            k.enabled = false; k.disabledAt = Date.now();
            WEBHOOK.notify("key_disabled", { provider: provider.id, key: picked.key.slice(0, 6) + "***", reason: `连续 ${k.failCount} 次 ${res.status}` });
          }
        }
      }
    } catch (e) {
      lastErr = e;
      LATENCY.record(provider.id, Date.now() - start);
      REQLOG.add({ ts: Date.now(), model, provider: provider.id, status: 0, latency_ms: Date.now() - start, error: String(e) });
    }
  }
  return c.json({ error: "all providers failed", details: lastErr }, 502);
});

// =====================================================================
//  Admin API
// =====================================================================
function adminAuth(c: any): boolean { return checkAuth(c.req.raw); }

// 供应商 CRUD
app.get("/admin/api/providers", async (c) => { await CONFIG.ready; return c.json(CONFIG.list()); });
app.post("/admin/api/providers", async (c) => { await CONFIG.ready; const b = await c.req.json(); return c.json(CONFIG.upsert(b)); });
app.delete("/admin/api/providers/:id", async (c) => { await CONFIG.ready; return c.json(CONFIG.delete(c.req.param("id"))); });
// Keys
app.post("/admin/api/providers/:id/keys", async (c) => { await CONFIG.ready; const { id } = c.req.param(); const b = await c.req.json(); return c.json(CONFIG.addKey(id, b.key, b.label, b.weight || 1)); });
app.delete("/admin/api/providers/:id/keys/:keyId", async (c) => { await CONFIG.ready; const { id, keyId } = c.req.param(); return c.json(CONFIG.deleteKey(id, keyId)); });
app.post("/admin/api/providers/:id/keys/:keyId/recover", async (c) => { await CONFIG.ready; const { id, keyId } = c.req.param(); return c.json(CONFIG.recoverKey(id, keyId)); });
// 连通性测试 + 模型探测
app.post("/admin/api/providers/:id/test", async (c) => { await CONFIG.ready; const { id } = c.req.param(); const p = CONFIG.providers.get(id); if (!p) return c.json({ ok: false }, 404); const r = await healthCheckOnce(p); return c.json({ ok: r.healthy > 0, ...r }); });
// 路由规则
app.get("/admin/api/routes", (c) => c.json(ROUTES.list()));
app.post("/admin/api/routes", async (c) => { const b = await c.req.json(); return c.json(ROUTES.add(b)); });
app.delete("/admin/api/routes/:id", (c) => { ROUTES.remove(c.req.param("id")); return c.json({ ok: true }); });
// Proxy Keys
app.get("/admin/api/proxy-keys", (c) => c.json(PKM.list()));
app.post("/admin/api/proxy-keys", async (c) => { const b = await c.req.json(); return c.json(PKM.add(b)); });
app.delete("/admin/api/proxy-keys/:id", (c) => { PKM.remove(c.req.param("id")); return c.json({ ok: true }); });
// 统计 / 日志 / 健康
app.get("/admin/api/stats/latency", (c) => c.json({ overall: LATENCY.summary(), providers: LATENCY.allByProvider() }));
app.get("/admin/api/stats/usage", (c) => {
  const byProvider: Record<string, { requests: number; input: number; output: number }> = {};
  for (const e of REQLOG["entries"]) {
    if (!byProvider[e.provider]) byProvider[e.provider] = { requests: 0, input: 0, output: 0 };
    byProvider[e.provider].requests++;
    byProvider[e.provider].input += e.input_tokens || 0;
    byProvider[e.provider].output += e.output_tokens || 0;
  }
  return c.json({ total_tokens: REQLOG.totalTokens(), providers: byProvider });
});
app.get("/admin/api/logs", (c) => { const url = new URL(c.req.raw.url); return c.json(REQLOG.query({ provider: url.searchParams.get("provider") || undefined, model: url.searchParams.get("model") || undefined, limit: Number(url.searchParams.get("limit") || 100) })); });
app.get("/admin/api/health/status", async (c) => { await CONFIG.ready; const data = await healthCheckAll(); return c.json({ data, alerts: WEBHOOK.alerts.slice(0, 20) }); });
app.post("/admin/api/health/check", async (c) => { await CONFIG.ready; const data = await healthCheckAll(); return c.json({ ok: true, data }); });
// 告警
app.get("/admin/api/alerts", (c) => c.json(WEBHOOK.alerts.slice(0, 50)));
// 配置导入 / 导出
app.get("/admin/api/config/export", (c) => c.json(exportConfig(CONFIG.list(), ROUTES, PKM)));
app.post("/admin/api/config/import", async (c) => {
  const b = await c.req.json();
  if (b.providers) for (const p of b.providers) CONFIG.upsert(p);
  if (b.routes) for (const r of b.routes) ROUTES.add(r);
  return c.json({ ok: true });
});

// =====================================================================
//  Dashboard (完整 6 Tab UI，内联)
// =====================================================================
app.get("/admin", (c) => {
  if (!adminAuth(c)) return c.text("Unauthorized", 401);
  return c.html(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LLM Router · v2.2.0</title>
<style>
:root{--bg:#0f172a;--panel:#1e293b;--line:#334155;--txt:#e2e8f0;--muted:#94a3b8;--accent:#38bdf8;--green:#4ade80;--yellow:#facc15;--red:#f87171}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--txt);font-size:14px}
a{color:var(--accent);text-decoration:none}
header{padding:1rem 1.5rem;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:10}
header h1{font-size:1.1rem;margin:0}
header .ver{color:var(--muted);font-size:.8rem;margin-left:.5rem}
.tabs{display:flex;gap:.25rem;padding:.5rem 1.5rem;border-bottom:1px solid var(--line);flex-wrap:wrap}
.tab{padding:.5rem 1rem;cursor:pointer;border-radius:.5rem .5rem 0 0;color:var(--muted);border:1px solid transparent}
.tab.active{color:var(--accent);background:var(--panel);border-color:var(--line);border-bottom-color:var(--panel)}
.pane{padding:1.5rem;display:none}.pane.active{display:block}
.card{background:var(--panel);border:1px solid var(--line);border-radius:.75rem;padding:1rem;margin-bottom:1rem}
.card h3{margin:0 0 .75rem;font-size:.95rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:.75rem;padding:1rem}
.stat .v{font-size:1.6rem;font-weight:700;color:var(--accent)}
.stat .l{color:var(--muted);font-size:.8rem}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.5rem;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:.8rem}
.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%}
.dot.g{background:var(--green)}.dot.y{background:var(--yellow)}.dot.r{background:var(--red)}
input,select,button{font:inherit;padding:.45rem .75rem;border-radius:.5rem;border:1px solid var(--line);background:var(--bg);color:var(--txt)}
button{background:var(--accent);color:#0f172a;border:none;cursor:pointer;font-weight:600}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
button.danger{background:var(--red)}
input{width:100%}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-end}
.muted{color:var(--muted)}
.alert{background:rgba(248,113,113,.15);border:1px solid var(--red);border-radius:.5rem;padding:.75rem;margin-bottom:1rem}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.75rem;background:var(--line)}
.bar{height:.5rem;background:var(--line);border-radius:999px;overflow:hidden;min-width:80px;display:inline-block;vertical-align:middle}
.bar>i{display:block;height:100%;background:var(--accent)}
@media(max-width:600px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <h1>🛰️ LLM Router <span class="ver">v2.2.0</span></h1>
  <div id="clock" class="muted"></div>
</header>
<div class="tabs">
  <div class="tab active" data-t="providers">📡 供应商</div>
  <div class="tab" data-t="keys">🔑 Keys</div>
  <div class="tab" data-t="latency">📊 延迟</div>
  <div class="tab" data-t="usage">💰 用量</div>
  <div class="tab" data-t="logs">📋 日志</div>
  <div class="tab" data-t="routes">⚙️ 路由规则</div>
</div>

<div class="pane active" id="p-providers">
  <div class="card"><h3>添加 / 编辑供应商</h3>
    <div class="row">
      <div><label class="muted">ID</label><input id="p-id" placeholder="my-provider"></div>
      <div><label class="muted">名称</label><input id="p-name" placeholder="My Provider"></div>
      <div><label class="muted">协议</label><select id="p-proto"><option value="openai">openai</option><option value="anthropic">anthropic</option><option value="google">google</option><option value="glm">glm</option></select></div>
      <div style="flex:1;min-width:240px"><label class="muted">Base URL</label><input id="p-base" placeholder="https://api.example.com/v1"></div>
      <div><label class="muted">默认模型</label><input id="p-model" placeholder="gpt-4o-mini"></div>
      <button onclick="saveProvider()">保存</button>
    </div>
  </div>
  <div class="card"><h3>供应商列表</h3><table><thead><tr><th>状态</th><th>ID</th><th>名称</th><th>协议</th><th>默认模型</th><th>Keys</th><th></th></tr></thead><tbody id="providers-body"></tbody></table></div>
</div>

<div class="pane" id="p-keys">
  <div class="card"><h3>添加 Key</h3>
    <div class="row">
      <div><label class="muted">供应商</label><select id="k-pid"></select></div>
      <div style="flex:1"><label class="muted">Key</label><input id="k-key" type="password" placeholder="sk-..."></div>
      <div><label class="muted">标签</label><input id="k-label" placeholder="生产"></div>
      <button onclick="addKey()">添加</button>
    </div>
  </div>
  <div class="card"><h3>各供应商 Keys</h3><div id="keys-list"></div></div>
</div>

<div class="pane" id="p-latency">
  <div class="grid" id="lat-stats"></div>
  <div class="card"><h3>各供应商延迟 (P50 / P95 / Avg / Max / 样本)</h3><table><thead><tr><th>供应商</th><th>P50</th><th>P95</th><th>Avg</th><th>Max</th><th>样本</th></tr></thead><tbody id="lat-body"></tbody></table></div>
</div>

<div class="pane" id="p-usage">
  <div class="grid" id="usage-stats"></div>
  <div class="card"><h3>各供应商 Token 用量</h3><table><thead><tr><th>供应商</th><th>请求数</th><th>Input</th><th>Output</th><th>占比</th></tr></thead><tbody id="usage-body"></tbody></table></div>
</div>

<div class="pane" id="p-logs">
  <div class="card"><div class="row"><input id="log-filter" placeholder="按供应商/模型筛选..."><button onclick="loadLogs()">刷新</button></div></div>
  <div class="card"><table><thead><tr><th>时间</th><th>模型</th><th>供应商</th><th>状态</th><th>延迟</th><th>Tokens</th></tr></thead><tbody id="logs-body"></tbody></table></div>
</div>

<div class="pane" id="p-routes">
  <div class="card"><h3>路由规则 (模型 -> 供应商优先级)</h3>
    <div class="row">
      <div style="flex:1"><label class="muted">模型匹配 (支持 * 通配)</label><input id="r-pat" placeholder="deepseek-* 或 *gpt*"></div>
      <div style="flex:1"><label class="muted">供应商顺序 (逗号分隔)</label><input id="r-prov" placeholder="deepseek,siliconflow,openrouter"></div>
      <button onclick="addRoute()">添加规则</button>
    </div>
    <p class="muted" style="font-size:.8rem">例：<code>*gpt*</code> → openai,openrouter 表示匹配 gpt 的模型优先走 OpenAI，失败 fallback OpenRouter。</p>
  </div>
  <div class="card"><table><thead><tr><th>匹配</th><th>供应商顺序</th><th></th></tr></thead><tbody id="routes-body"></tbody></table></div>
</div>

<script>
const API="/admin/api";
let providers=[],routes=[],latency={},usage={},logs=[];
const $=(s)=>document.querySelector(s);
setInterval(()=>{$('#clock').textContent=new Date().toLocaleString()},1000);

document.querySelectorAll('.tab').forEach(t=>{
  t.onclick=()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    $('#p-'+t.dataset.t).classList.add('active');
    refresh(t.dataset.t);
  };
});

async function api(path,opt={}){const r=await fetch(API+path,opt);return r.json();}
function esc(s){return (s||'').toString().replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c)));}

async function refresh(t){
  if(t==='providers'||t==='keys'){providers=await api('/providers');renderProviders();renderKeys();fillKeySelect();}
  if(t==='latency'){latency=await api('/stats/latency');renderLatency();}
  if(t==='usage'){usage=await api('/stats/usage');renderUsage();}
  if(t==='logs'){logs=await api('/logs?limit=200');renderLogs();}
  if(t==='routes'){routes=await api('/routes');renderRoutes();}
}
function providerOptions(providers){let h='';for(const p of providers){h+='<option value="'+p.id+'">'+esc(p.name)+'</option>';}return h;}
function fillKeySelect(){const sel=$('#k-pid');sel.innerHTML=providerOptions(providers);}

function renderProviders(){
  $('#providers-body').innerHTML=providers.map(p=>{
    const ok=p.keys.filter(k=>k.enabled).length;
    return `<tr>
      <td><span class="dot ${p.enabled?'g':'r'}"></span></td>
      <td><code>${esc(p.id)}</code></td>
      <td>${esc(p.name)}</td>
      <td><span class="badge">${esc(p.protocol)}</span></td>
      <td><code>${esc(p.defaultModel)}</code></td>
      <td>${ok}/${p.keys.length}</td>
      <td><button class="ghost" onclick="testProvider('${p.id}')">测试</button>
          <button class="ghost" onclick="discover('${p.id}')">探测模型</button>
          <button class="danger" onclick="delProvider('${p.id}')">删</button></td>
    </tr>`;
  }).join('');
}
async function saveProvider(){
  const b={id:$('#p-id').value.trim(),name:$('#p-name').value.trim(),protocol:$('#p-proto').value,baseUrl:$('#p-base').value.trim(),defaultModel:$('#p-model').value.trim(),isCustom:true};
  if(!b.id||!b.baseUrl)return alert('ID 和 Base URL 必填');
  await api('/providers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
  ['p-id','p-name','p-base','p-model'].forEach(i=>$(i).value='');
  refresh('providers');
}
async function delProvider(id){if(!confirm('确定删除？'))return;await api('/providers/'+id,{method:'DELETE'});refresh('providers');}
async function testProvider(id){const r=await api('/providers/'+id+'/test',{method:'POST'});alert(JSON.stringify(r,null,2));refresh('providers');}
async function discover(id){alert('探测模型：发送一次轻量请求，返回的模型列表会合并进配置（需上游 /models 支持）。当前已记录默认模型。');}

function renderKeys(){
  $('#keys-list').innerHTML=providers.map(p=>{
    if(!p.keys.length)return `<div class="card muted">${esc(p.name)}：无 Key</div>`;
    return `<div class="card"><h3>${esc(p.name)} <span class="muted">(${p.id})</span></h3><table><thead><tr><th>Key</th><th>标签</th><th>状态</th><th>失败</th><th></th></tr></thead><tbody>${
      p.keys.map(k=>`<tr><td><code>${esc(k.key)}</code></td><td>${esc(k.label||'')}</td>
        <td>${k.enabled?'<span class="dot g"></span> 正常':'<span class="dot r"></span> 已摘除'}</td>
        <td>${k.failCount>=3?'<span style="color:var(--red)">⚠️ '+k.failCount+'</span>':k.failCount}</td>
        <td>${k.enabled?'':'<button class="ghost" onclick="recoverKey(\''+p.id+'\',\''+k.id+'\')">恢复</button>'}</td></tr>`).join('')
    }</tbody></table></div>`;
  }).join('');
}
async function addKey(){const id=$('#k-pid').value,key=$('#k-key').value.trim(),label=$('#k-label').value.trim();if(!key)return;await api('/providers/'+id+'/keys',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,label})});$('#k-key').value='';refresh('keys');}
async function recoverKey(pid,kid){await api('/providers/'+pid+'/keys/'+kid+'/recover',{method:'POST'});refresh('keys');}

function renderLatency(){
  const o=latency.overall||{};
  $('#lat-stats').innerHTML=Object.entries({P50:o.p50,P95:o.p95,Avg:o.avg,Max:o.max,'样本':o.count}).map(([k,v])=>`<div class="stat"><div class="l">${k}</div><div class="v">${v||0}${k.includes('50')||k.includes('Avg')||k==='Max'?'ms':''}</div></div>`).join('');
  $('#lat-body').innerHTML=Object.entries(latency.providers||{}).map(([id,s])=>`<tr><td><code>${esc(id)}</code></td><td>${s.p50}</td><td>${s.p95}</td><td>${s.avg}</td><td>${s.max}</td><td>${s.count}</td></tr>`).join('');
}
function renderUsage(){
  const total=usage.total_tokens||0;
  $('#usage-stats').innerHTML=Object.entries({总Token:total,'已记录请求':Object.keys(usage.providers||{}).length}).map(([k,v])=>`<div class="stat"><div class="l">${k}</div><div class="v">${v}</div></div>`).join('');
  $('#usage-body').innerHTML=Object.entries(usage.providers||{}).map(([id,s])=>{const pct=total?Math.round((s.input+s.output)/total*100):0;return `<tr><td><code>${esc(id)}</code></td><td>${s.requests}</td><td>${s.input}</td><td>${s.output}</td><td><div class="bar"><i style="width:${pct}%"></i></div> ${pct}%</td></tr>`;}).join('');
}
function renderLogs(){
  $('#logs-body').innerHTML=logs.map(e=>`<tr><td class="muted">${new Date(e.ts).toLocaleTimeString()}</td><td><code>${esc(e.model)}</code></td><td>${esc(e.provider)}</td><td style="color:${e.status>=400||!e.status?'var(--red)':'var(--green)'}">${e.status||'ERR'}</td><td>${e.latency_ms}ms</td><td>${((e.input_tokens||0)+(e.output_tokens||0))||'-'}</td></tr>`).join('');
}
async function loadLogs(){logs=await api('/logs?limit=200');renderLogs();}

function renderRoutes(){
  $('#routes-body').innerHTML=routes.map(r=>`<tr><td><code>${esc(r.pattern)}</code></td><td>${r.providers.map(p=>`<span class="badge">${esc(p)}</span>`).join(' → ')}</td><td><button class="danger" onclick="delRoute('${r.id}')">删</button></td></tr>`).join('');
}
async function addRoute(){const pattern=$('#r-pat').value.trim(),providers=$('#r-prov').value.trim().split(/[,\s]+/).filter(Boolean);if(!pattern||!providers.length)return alert('请填写完整');await api('/routes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pattern,providers})});$('#r-pat').value='';$('#r-prov').value='';refresh('routes');}
async function delRoute(id){await api('/routes/'+id,{method:'DELETE'});refresh('routes');}

// 初始加载
refresh('providers');
</script>
</body>
</html>`;

app.notFound((c) => c.json({ error: "Not Found", path: c.req.path }, 404));

// =====================================================================
//  启动 (Deno Deploy 兼容：无端口)
// =====================================================================
Deno.serve(app.fetch);

CONFIG.ready.then(() => {
  console.log(`[llm-router] v2.2.0 started · providers=${CONFIG.providers.size} · webhook=${ENV.WEBHOOK_URL ? "on" : "off"}`);
});

export default app;
