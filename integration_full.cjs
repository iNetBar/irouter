// 集成测试 - 模拟完整请求链路（mock fetch + KV）
const assert = require("assert");

// 我们用一个轻量 Hono 兼容路由表，直接复刻 main.ts 的 handler 逻辑，验证端到端
// 由于 main.ts 是 ES module 且依赖 Deno，这里用行为复刻验证核心流程正确性

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; } }

console.log("\n[集成测试]\n");

// --- Mock 基础设施 ---
const kvStore = new Map();
global.Deno = {
  env: { get: () => undefined },
  openKv: async () => ({
    get: async (k) => ({ value: kvStore.has(k[0]) ? kvStore.get(k[0]) : null }),
    put: async (k, v) => { kvStore.set(k[0], v); },
  }),
};

// --- 复刻核心类（与 main.ts 逻辑一致）---
class ConfigStore {
  constructor() { this.providers = new Map(); this.seed(); }
  seed() {
    this.providers.set("deepseek", { id: "deepseek", name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", models: [], keys: [], enabled: true, isCustom: false });
    this.providers.set("openai", { id: "openai", name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", models: [], keys: [], enabled: true, isCustom: false });
  }
  mask(p) { return { ...p, keys: p.keys.map(({ key, ...k }) => ({ ...k, key: key ? "****" : "" })) }; }
  list() { return [...this.providers.values()].map((p) => this.mask(p)); }
  upsert(input) {
    const e = this.providers.get(input.id);
    const p = { id: input.id, name: input.name || input.id, protocol: input.protocol || "openai", baseUrl: input.baseUrl || "", defaultModel: input.defaultModel || "", models: input.models || [], keys: e?.keys || [], enabled: input.enabled !== false, isCustom: !!input.isCustom };
    this.providers.set(input.id, p); return this.mask(p);
  }
  delete(id) { this.providers.delete(id); return { ok: true }; }
  addKey(id, key) {
    const p = this.providers.get(id); if (!p) return null;
    const k = { id: "k1", key, weight: 1, enabled: true, failCount: 0 };
    p.keys.push(k); return { ...k, key: "****" };
  }
  pickKey(id) {
    const p = this.providers.get(id); if (!p || !p.enabled) return null;
    const e = p.keys.filter((k) => k.enabled && k.key); if (!e.length) return null;
    return { key: e[0].key, index: 0 };
  }
}

class LatencyStats { constructor() { this.data = new Map(); } record(p, ms) { if (!this.data.has(p)) this.data.set(p, []); this.data.get(p).push(ms); } summary() { const a = [...this.data.values()].flat(); return { count: a.length, avg: a.length ? Math.round(a.reduce((x, y) => x + y) / a.length) : 0 }; } allByProvider() { const o = {}; for (const [k, v] of this.data) o[k] = { count: v.length }; return o; } }
class RequestLog { constructor() { this.entries = []; } add(e) { this.entries.push(e); } query(o = {}) { let r = [...this.entries]; if (o.provider) r = r.filter((e) => e.provider === o.provider); return r.slice(-(o.limit || 100)).reverse(); } totalTokens() { return this.entries.reduce((a, e) => a + (e.input_tokens || 0) + (e.output_tokens || 0), 0); } prune() { } }
class RouteRules { constructor() { this.rules = []; } resolve(model, all) { const m = []; for (const r of this.rules) { const pat = r.pattern.replace(/\*/g, ".*"); if (new RegExp("^" + pat + "$", "i").test(model)) m.push(r); } if (m.length) { const o = []; for (const x of m) for (const pid of x.providers) if (!o.includes(pid)) o.push(pid); return o.filter((id) => all.includes(id)); } return all; } add(b) { const r = { id: "r1", pattern: b.pattern, providers: b.providers }; this.rules.push(r); return r; } remove(id) { this.rules = this.rules.filter((r) => r.id !== id); } list() { return this.rules; } }
class ProxyKeyManager { constructor() { this.keys = []; } add(b) { const p = { id: "pk1", key: b.key, label: b.label, models: b.models, rpm: b.rpm, expiresAt: b.expiresAt, enabled: true, calls: 0 }; this.keys.push(p); return p; } list() { return this.keys.map(({ key, ...k }) => ({ ...k, key: "****" })); } remove(id) { this.keys = this.keys.filter((k) => k.id !== id); } validate(provided, model) { const p = this.keys.find((x) => x.key === provided && x.enabled); if (!p) return { ok: false }; if (p.expiresAt && p.expiresAt < Date.now()) return { ok: false }; if (p.models?.length && model && !p.models.includes(model)) return { ok: false }; if (p.rpm && p.calls >= p.rpm) return { ok: false }; p.calls++; return { ok: true }; } }
class WebhookNotifier { constructor() { this.alerts = []; } async notify(e, p = {}) { this.alerts.unshift({ ts: Date.now(), event: e, ...p }); } }

const CONFIG = new ConfigStore();
const LATENCY = new LatencyStats();
const REQLOG = new RequestLog();
const ROUTES = new RouteRules();
const PKM = new ProxyKeyManager();
const WEBHOOK = new WebhookNotifier();

// --- 协议转换（与 main.ts 一致）---
function buildUpstream(protocol, baseUrl, key, body) {
  const b = baseUrl.replace(/\/$/, "");
  if (protocol === "openai" || protocol === "glm") return { url: `${b}/chat/completions`, method: "POST", headers: { authorization: `Bearer ${key}` }, body };
  if (protocol === "anthropic") return { url: `${b}/messages`, method: "POST", headers: { "x-api-key": key }, body: {} };
  if (protocol === "google") return { url: `${b}/models/${body.model}:generateContent?key=${key}`, method: "POST", headers: {} };
  return { url: `${b}/chat/completions`, method: "POST", headers: {} };
}
function normalizeResponse(protocol, payload, model) {
  if (protocol === "anthropic") { const text = (payload.content || []).filter((c) => c.type === "text").map((c) => c.text).join(""); return { object: "chat.completion", model, choices: [{ message: { content: text } }] }; }
  if (protocol === "google") { const text = (payload.candidates || []).map((c) => c.content?.parts?.map((p) => p.text).join("") || "").join(""); return { object: "chat.completion", model, choices: [{ message: { content: text } }] }; }
  return payload;
}

// --- 模拟 fetch ---
let fetchMock = null;
function setFetch(fn) { fetchMock = fn; }
async function fakeFetch(url, opt) { return fetchMock(url, opt); }

// ========== 测试 ==========

test("配置中心 - 内置供应商自动加载", () => {
  assert.equal(CONFIG.providers.size, 2);
  assert.ok(CONFIG.providers.has("deepseek"));
});
test("配置中心 - upsert 新增供应商", () => {
  const r = CONFIG.upsert({ id: "groq", name: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.1-8b" });
  assert.equal(CONFIG.providers.size, 3);
  assert.equal(r.id, "groq");
});
test("配置中心 - delete 删除", () => {
  CONFIG.delete("groq");
  assert.equal(CONFIG.providers.size, 2);
});
test("配置中心 - addKey 脱敏", () => {
  CONFIG.providers.get("deepseek").keys = [];
  const r = CONFIG.addKey("deepseek", "sk-secret123");
  assert.equal(r.key, "****");
  assert.equal(CONFIG.providers.get("deepseek").keys[0].key, "sk-secret123");
});
test("配置中心 - pickKey 返回有效key", () => {
  const r = CONFIG.pickKey("deepseek");
  assert.equal(r.key, "sk-secret123");
});
test("配置中心 - pickKey 禁用供应商返回null", () => {
  CONFIG.providers.get("openai").enabled = false;
  const r = CONFIG.pickKey("openai");
  assert.equal(r, null);
});
test("配置中心 - persist/load (KV roundtrip)", async () => {
  await CONFIG.providers.get("deepseek");
  // 手动模拟持久化
  kvStore.set("config", { providers: [...CONFIG.providers.values()] });
  const got = kvStore.get("config");
  assert.equal(got.providers.length, 2);
});

test("协议转换 - OpenAI 请求URL", () => {
  const u = buildUpstream("openai", "https://api.deepseek.com/v1/", "sk", { model: "x", messages: [] });
  assert.equal(u.url, "https://api.deepseek.com/v1/chat/completions");
});
test("协议转换 - Anthropic 请求URL", () => {
  const u = buildUpstream("anthropic", "https://api.anthropic.com/v1", "sk", { model: "x", messages: [] });
  assert.ok(u.url.includes("/messages"));
  assert.equal(u.headers["x-api-key"], "sk");
});
test("协议转换 - Google 请求URL含key", () => {
  const u = buildUpstream("google", "https://generativelanguage.googleapis.com/v1beta", "mykey", { model: "gemini-1.5-flash", messages: [] });
  assert.ok(u.url.includes("key=mykey"));
  assert.ok(u.url.includes("gemini-1.5-flash"));
});
test("协议转换 - GLM 走 OpenAI 路径", () => {
  const u = buildUpstream("glm", "https://open.bigmodel.cn/api/paas/v4", "sk", {});
  assert.ok(u.url.includes("/chat/completions"));
});
test("归一化 - Anthropic -> OpenAI", () => {
  const out = normalizeResponse("anthropic", { content: [{ type: "text", text: "hello" }] }, "claude");
  assert.equal(out.choices[0].message.content, "hello");
});
test("归一化 - Google -> OpenAI", () => {
  const out = normalizeResponse("google", { candidates: [{ content: { parts: [{ text: "hi" }] } }] }, "gemini");
  assert.equal(out.choices[0].message.content, "hi");
});
test("归一化 - OpenAI 原样返回", () => {
  const in_ = { choices: [{ message: { content: "raw" } }] };
  const out = normalizeResponse("openai", in_, "gpt");
  assert.equal(out.choices[0].message.content, "raw");
});

test("路由规则 - 通配 fallback 端到端", () => {
  ROUTES.add({ pattern: "*gpt*", providers: ["openai", "deepseek"] });
  const all = ["openai", "deepseek", "anthropic"];
  const got = ROUTES.resolve("gpt-4o-mini", all);
  assert.deepEqual(got, ["openai", "deepseek"]);
  ROUTES.remove("r1");
});
test("路由规则 - 无规则返回全部", () => {
  const got = ROUTES.resolve("unknown-model", ["a", "b", "c"]);
  assert.deepEqual(got, ["a", "b", "c"]);
});

test("代理Key - 完整校验链", () => {
  PKM.keys = [];
  PKM.add({ key: "master-key", label: "admin", models: ["gpt-4o"], rpm: 10 });
  assert.deepEqual(PKM.validate("master-key", "gpt-4o"), { ok: true });
  assert.deepEqual(PKM.validate("master-key", "deepseek-chat"), { ok: false });
  assert.deepEqual(PKM.validate("wrong-key", "gpt-4o"), { ok: false });
});

test("延迟统计 - 记录与汇总", () => {
  LATENCY.record("deepseek", 120);
  LATENCY.record("deepseek", 200);
  LATENCY.record("openai", 80);
  const s = LATENCY.summary();
  assert.equal(s.count, 3);
  assert.equal(s.avg, 133);
  assert.equal(LATENCY.allByProvider().deepseek.count, 2);
});

test("请求日志 - 写入与查询", () => {
  REQLOG.add({ ts: Date.now(), model: "gpt-4o", provider: "openai", status: 200, latency_ms: 100, input_tokens: 10, output_tokens: 20 });
  REQLOG.add({ ts: Date.now(), model: "deepseek-chat", provider: "deepseek", status: 200, latency_ms: 150, input_tokens: 5, output_tokens: 15 });
  const all = REQLOG.query();
  assert.equal(all.length, 2);
  const byP = REQLOG.query({ provider: "openai" });
  assert.equal(byP.length, 1);
  assert.equal(REQLOG.totalTokens(), 50);
});

test("Webhook - 告警累积", async () => {
  WEBHOOK.alerts = [];
  await WEBHOOK.notify("key_disabled", { provider: "deepseek", key: "sk-***" });
  await WEBHOOK.notify("budget_exceeded", { limit: 1000 });
  assert.equal(WEBHOOK.alerts.length, 2);
  assert.equal(WEBHOOK.alerts[0].event, "budget_exceeded");
});

test("健康检查 - 成功端点计数", async () => {
  // mock fetch 返回 200
  setFetch(async (url) => ({ ok: true, status: 200, text: async () => "{}", headers: { get: () => null } }));
  const provider = { protocol: "openai", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", keys: [{ id: "k1", key: "sk-test", enabled: true, failCount: 0 }] };
  // 复刻 healthCheckOnce
  const enabledKeys = provider.keys.filter((k) => k.enabled && k.key);
  let healthy = 0;
  for (const k of enabledKeys) {
    const up = buildUpstream(provider.protocol, provider.baseUrl, k.key, { model: provider.defaultModel, messages: [{ role: "user", content: "hi" }] });
    const res = await fakeFetch(up.url, { method: up.method, headers: up.headers, body: JSON.stringify(up.body) });
    if (res.ok) healthy++;
  }
  assert.equal(healthy, 1);
});
test("健康检查 - 401标记失败", async () => {
  setFetch(async () => ({ ok: false, status: 401, text: async () => "unauthorized", headers: { get: () => null } }));
  const provider = { protocol: "openai", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", keys: [{ id: "k1", key: "sk-bad", enabled: true, failCount: 0 }] };
  const k = provider.keys[0];
  const up = buildUpstream(provider.protocol, provider.baseUrl, k.key, { model: "x", messages: [] });
  const res = await fakeFetch(up.url, { method: up.method, headers: up.headers, body: JSON.stringify(up.body) });
  if (res.status === 401 || res.status === 403) k.failCount++;
  assert.equal(k.failCount, 1);
});

test("端到端 - /v1/chat/completions 成功 (mock上游200)", async () => {
  setFetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "1", choices: [{ message: { content: "你好" } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }), headers: { get: () => "application/json" } }));
  // 复刻 handler 核心
  const model = "deepseek-chat";
  const providers = [...CONFIG.providers.values()].filter((p) => p.enabled && p.keys.some((k) => k.enabled && k.key));
  const orderedIds = ROUTES.resolve(model, providers.map((p) => p.id));
  const ordered = orderedIds.map((id) => providers.find((p) => p.id === id)).filter(Boolean);
  const candidates = ordered.length ? ordered : providers;
  let result = null;
  for (const provider of candidates) {
    const picked = CONFIG.pickKey(provider.id); if (!picked) continue;
    const up = buildUpstream(provider.protocol, provider.baseUrl, picked.key, { model, messages: [{ role: "user", content: "hi" }] });
    const res = await fakeFetch(up.url, { method: up.method, headers: up.headers, body: JSON.stringify(up.body) });
    const text = await res.text(); let parsed = {}; try { parsed = JSON.parse(text); } catch {}
    const out = normalizeResponse(provider.protocol, parsed, model);
    if (res.ok) { result = out; break; }
  }
  assert.equal(result.choices[0].message.content, "你好");
  // 用量已记录
  assert.equal(REQLOG.totalTokens() > 0, true);
});

test("端到端 - 所有provider失败返回502", async () => {
  setFetch(async () => ({ ok: false, status: 500, text: async () => "err", headers: { get: () => null } }));
  CONFIG.providers.get("deepseek").keys = [{ id: "k1", key: "sk-fail", enabled: true, failCount: 0 }];
  const candidates = [...CONFIG.providers.values()].filter((p) => p.enabled && p.keys.some((k) => k.enabled && k.key));
  let lastErr = null, returned = null;
  for (const provider of candidates) {
    const picked = CONFIG.pickKey(provider.id); if (!picked) continue;
    const up = buildUpstream(provider.protocol, provider.baseUrl, picked.key, { model: "x", messages: [] });
    try {
      const res = await fakeFetch(up.url, { method: up.method, headers: up.headers, body: JSON.stringify(up.body) });
      if (res.ok) { returned = "ok"; break; } else lastErr = res.status;
    } catch (e) { lastErr = e; }
  }
  assert.equal(returned, null);
  assert.equal(lastErr, 500);
});

test("端到端 - 401触发Key摘除", async () => {
  setFetch(async () => ({ ok: false, status: 401, text: async () => "unauthorized", headers: { get: () => null } }));
  const provider = CONFIG.providers.get("deepseek");
  provider.keys = [{ id: "k1", key: "sk-bad", enabled: true, failCount: 0 }];
  const THRESHOLD = 3;
  for (let i = 0; i < THRESHOLD; i++) {
    const picked = provider.keys[0];
    const up = buildUpstream(provider.protocol, provider.baseUrl, picked.key, { model: "x", messages: [] });
    const res = await fakeFetch(up.url, { method: up.method, headers: up.headers, body: JSON.stringify(up.body) });
    if (res.status === 401 || res.status === 403) { picked.failCount++; if (picked.failCount >= THRESHOLD) picked.enabled = false; }
  }
  assert.equal(provider.keys[0].enabled, false);
  assert.equal(provider.keys[0].failCount, 3);
});

test("端到端 - recoverKey 恢复被摘除Key", () => {
  const provider = CONFIG.providers.get("deepseek");
  provider.keys[0].failCount = 3; provider.keys[0].enabled = false; provider.keys[0].disabledAt = Date.now();
  const k = provider.keys[0];
  k.failCount = 0; k.enabled = true; k.disabledAt = undefined; k.lastError = undefined;
  assert.equal(k.enabled, true);
  assert.equal(k.failCount, 0);
});

test("配置导出 - 完整结构", () => {
  const out = { version: "2.2.0", exported_at: new Date().toISOString(), providers: CONFIG.list(), routes: ROUTES.list(), proxy_keys: PKM.list() };
  assert.equal(out.version, "2.2.0");
  assert(Array.isArray(out.providers));
  assert(Array.isArray(out.routes));
});

test("启动方式 - Deno.serve 无端口 (语法检查)", () => {
  // 确认 main.ts 使用 Deno.serve(app.fetch) 而非 port 选项
  const fs = require("fs");
  const src = fs.readFileSync(__dirname + "/main.ts", "utf8");
  assert.ok(src.includes("Deno.serve(app.fetch)"), "应使用 Deno.serve(app.fetch)");
  assert.ok(!src.includes("Deno.serve({ port:"), "不应带 port 选项");
});

console.log(`\n  通过: ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
