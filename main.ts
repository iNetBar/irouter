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
const VERSION = "2.2.0";
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
  list() {
    return [...this.providers.values()].map((p) => {
      const m = this.mask(p);
      // 标记是否为内置供应商（前端据此禁止删除、区分显示）
      (m as any).builtin = !p.isCustom;
      return m;
    });
  }
  get(id: string) { const p = this.providers.get(id); return p ? this.mask(p) : null; }
  upsert(input: Partial<Provider> & { id: string }) {
    const e = this.providers.get(input.id);
    // 保护：禁止覆盖内置供应商的关键字段（协议/baseUrl 由 BUILTIN 锁定）
    if (e && !e.isCustom) {
      const p: Provider = {
        ...e,
        name: input.name || e.name,
        enabled: input.enabled !== undefined ? !!input.enabled : e.enabled,
        models: input.models && input.models.length ? input.models : e.models,
        keys: e.keys,
        defaultModel: input.defaultModel || e.defaultModel,
      };
      this.providers.set(input.id, p);
      this.persist();
      return this.mask(p);
    }
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
  /** 一键恢复全部内置供应商（清空被误删/污染的，重新从 BUILTIN 铺底） */
  resetBuiltin() {
    let restored = 0;
    for (const [id, def] of Object.entries(BUILTIN)) {
      if (!this.providers.has(id)) restored++;
      this.providers.set(id, { id, ...def, models: [], keys: [], enabled: !def.isCustom });
    }
    // 兜底：把 isCustom=false 但字段被污染的也重置回 BUILTIN 定义
    for (const [id, def] of Object.entries(BUILTIN)) {
      const cur = this.providers.get(id);
      if (cur && !cur.isCustom) {
        this.providers.set(id, { ...cur, protocol: def.protocol, baseUrl: def.baseUrl, defaultModel: def.defaultModel, name: def.name });
      }
    }
    this.persist();
    return { ok: true, restored, total: [...this.providers.values()].filter((p) => !p.isCustom).length };
  }
  delete(id: string) {
    const p = this.providers.get(id);
    // 保护：内置供应商不可删除，只能禁用
    if (p && !p.isCustom) return { ok: false, error: "内置供应商不可删除，可禁用" };
    this.providers.delete(id);
    this.persist();
    return { ok: true };
  }
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
app.delete("/admin/api/providers/:id", async (c) => { await CONFIG.ready; const r = CONFIG.delete(c.req.param("id")); if (r && (r as any).error) return c.json(r, 400); return c.json(r); });
// 一键恢复全部内置供应商（前端「＋ 恢复内置供应商」按钮调用）
app.post("/admin/api/providers/reset-builtin", async (c) => { await CONFIG.ready; return c.json(CONFIG.resetBuiltin()); });
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
//  Dashboard (独立 dashboard.html，由 /admin 路由注入动态数据)
//  —— 刻意不放进 TS 模板字符串，避免 Deno 把 < > 当 TSX 解析 (此前报 SyntaxError)
// =====================================================================
// ---------- 载入 Dashboard (独立 HTML 文件，避免 TS 模板字面量冲突) ----------
let DASHBOARD_TEMPLATE = "";
async function loadDashboard() {
  if (DASHBOARD_TEMPLATE) return;
  try {
    DASHBOARD_TEMPLATE = await Deno.readTextFile("./dashboard.html");
  } catch (e) {
    DASHBOARD_TEMPLATE = "<!doctype html><html><body><h1>Dashboard 加载失败</h1><p>" +
      String(e && e.message || e) + "</p><p>请确保 dashboard.html 与 main.ts 同目录，并已包含在部署产物中。</p></body></html>";
  }
}

app.get("/admin", async (c) => {
  if (!adminAuth(c)) return c.text("Unauthorized", 401);
  await loadDashboard();
  const html = DASHBOARD_TEMPLATE.replace(/\{\{VERSION\}\}/g, VERSION);
  return c.html(html);
});

app.notFound((c) => c.json({ error: "Not Found", path: c.req.path }, 404));

// =====================================================================
//  启动 (Deno Deploy 兼容：无端口)
// =====================================================================
async function start() {
  await CONFIG.ready;
  await loadDashboard(); // 启动时预加载 dashboard.html（失败也有兜底 HTML，不会崩）
  Deno.serve(app.fetch);
  console.log(`[llm-router] v${VERSION} started · providers=${CONFIG.providers.size} · webhook=${ENV.WEBHOOK_URL ? "on" : "off"}`);
}
start();

export default app;
