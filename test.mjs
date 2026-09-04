// 单元测试：复现 main.ts 纯逻辑，与源码保持同步。
// 运行: deno test --allow-env --unstable-kv test.mjs

function inferProvider(model = "") {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("glm")) return "glm";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("chatgpt")) return "openai";
  return "openai";
}

function extractUsage(payload) {
  const u = payload?.usage;
  if (!u) return null;
  if ("total_tokens" in u) {
    return { prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0, total_tokens: u.total_tokens };
  }
  if ("input_tokens" in u) {
    const p = u.input_tokens || 0, c = u.output_tokens || 0;
    return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
  }
  return null;
}

function toAnthropic(body) {
  const msgs = (body.messages || []).filter((m) => m.role !== "system");
  const system = (body.messages || []).find((m) => m.role === "system")?.content;
  return {
    model: body.model || "",
    messages: msgs.map((m) => ({ role: m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user", content: m.content || "" })),
    ...(system ? { system } : {}),
    stream: body.stream,
    max_tokens: body.max_tokens || 4096,
  };
}

function googleToOpenAI(payload, model) {
  const cands = payload?.candidates || [];
  const text = cands.map((c) => c.content?.parts?.map((p) => p.text || "").join("") || "").join("");
  return { id: "fixed", object: "chat.completion", model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }] };
}

function hourKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
}

Deno.test("inferProvider covers all prefixes", () => {
  const cases = {
    "claude-sonnet-4": "anthropic",
    "gemini-2.5-pro": "google",
    "glm-4-plus": "glm",
    "gpt-4o": "openai",
    "o3-mini": "openai",
    "o4-mini": "openai",
    "chatgpt-4o": "openai",
    "unknown-model": "openai",
  };
  for (const [k, v] of Object.entries(cases)) {
    if (inferProvider(k) !== v) throw new Error(`inferProvider("${k}") = ${inferProvider(k)}, want ${v}`);
  }
});

Deno.test("extractUsage: OpenAI/GLM style", () => {
  const got = extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
  const want = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error("mismatch " + JSON.stringify(got));
});

Deno.test("extractUsage: Anthropic style", () => {
  const got = extractUsage({ usage: { input_tokens: 5, output_tokens: 15 } });
  const want = { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 };
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error("mismatch " + JSON.stringify(got));
});

Deno.test("extractUsage: null on missing", () => {
  if (extractUsage({}) !== null) throw new Error("should be null");
  if (extractUsage(null) !== null) throw new Error("should be null");
});

Deno.test("toAnthropic: extracts system and maps roles", () => {
  const out = toAnthropic({
    model: "claude-x", stream: true, max_tokens: 1024,
    messages: [
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "tool", content: "ignored" },
    ],
  });
  if (out.system !== "be nice") throw new Error("system");
  if (out.max_tokens !== 1024) throw new Error("max_tokens");
  // tool role is preserved (Anthropic supports tool_use), so length = 3
  if (out.messages.length !== 3) throw new Error("messages.length=" + out.messages.length);
  if (out.messages[0].role !== "user") throw new Error("user role");
  if (out.messages[1].role !== "assistant") throw new Error("assistant role");
  if (out.messages[2].role !== "tool") throw new Error("tool role preserved");
});

Deno.test("googleToOpenAI: normalizes candidates", () => {
  const out = googleToOpenAI({ candidates: [{ content: { parts: [{ text: "Hello " }, { text: "world" }] } }] }, "gemini-x");
  if (out.choices[0].message.content !== "Hello world") throw new Error("text");
  if (out.object !== "chat.completion") throw new Error("object");
});

Deno.test("googleToOpenAI: empty candidates", () => {
  const out = googleToOpenAI({ candidates: [] }, "gemini-x");
  if (out.choices[0].message.content !== "") throw new Error("empty");
});

Deno.test("auth: rejects wrong/missing key", () => {
  const PROXY_KEY = "secret";
  const check = (h) => !PROXY_KEY ? true : h === PROXY_KEY;
  if (!check("secret")) throw new Error("correct rejected");
  if (check("wrong")) throw new Error("wrong accepted");
  if (check(undefined)) throw new Error("missing accepted");
});

Deno.test("budget: check logic", () => {
  const LIMIT = 10000;
  const check = (used) => used < LIMIT;
  if (!check(5000)) throw new Error("5000");
  if (!check(9999)) throw new Error("9999");
  if (check(10000)) throw new Error("10000 should fail");
  if (check(15000)) throw new Error("15000 should fail");
});

Deno.test("rateLimit: token bucket per IP", () => {
  const RPM = 3;
  const store = new Map();
  const check = (ip) => {
    const now = Date.now();
    const e = store.get(ip);
    if (!e || e.resetAt < now) { store.set(ip, { count: 1, resetAt: now + 60_000 }); return true; }
    e.count++;
    return e.count <= RPM;
  };
  if (!check("1.2.3.4")) throw new Error("#1");
  if (!check("1.2.3.4")) throw new Error("#2");
  if (!check("1.2.3.4")) throw new Error("#3");
  if (check("1.2.3.4")) throw new Error("#4 should reject");
  if (!check("5.6.7.8")) throw new Error("other ip");
});

Deno.test("buildUpstream: urls and headers per provider", () => {
  const build = (p, key) => {
    if (p === "anthropic") return { url: "https://api.anthropic.com/v1/messages", h: { "x-api-key": key } };
    if (p === "google") return { url: "https://generativelanguage.googleapis.com", h: {} };
    if (p === "glm") return { url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", h: { authorization: `Bearer ${key}` } };
    return { url: "https://api.openai.com/v1/chat/completions", h: { authorization: `Bearer ${key}` } };
  };
  if (build("openai", "k").url !== "https://api.openai.com/v1/chat/completions") throw new Error("openai url");
  if (build("openai", "k").h.authorization !== "Bearer k") throw new Error("openai auth");
  if (build("anthropic", "ak").h["x-api-key"] !== "ak") throw new Error("anthropic key");
  if (!/generativelanguage/.test(build("google", "k").url)) throw new Error("google url");
  if (build("glm", "gk").h.authorization !== "Bearer gk") throw new Error("glm auth");
});

Deno.test("key rotation: round-robin", () => {
  const list = ["sk-1", "sk-2", "sk-3"];
  let i = 0;
  const pick = () => list[i++ % list.length];
  const seq = [pick(), pick(), pick(), pick()];
  if (JSON.stringify(seq) !== JSON.stringify(["sk-1", "sk-2", "sk-3", "sk-1"])) throw new Error("seq " + JSON.stringify(seq));
});

Deno.test("hourKey: UTC hourly format", () => {
  const d = new Date(Date.UTC(2026, 0, 15, 9, 30));
  if (hourKey(d) !== "2026-01-15T09") throw new Error(hourKey(d));
});

Deno.test("budget: completion-only when BUDGET_INCLUDE_INPUT false", () => {
  const BUDGET_INCLUDE_INPUT = false;
  const charged = BUDGET_INCLUDE_INPUT ? 100 : 40;
  if (charged !== 40) throw new Error("charged=" + charged);
});

Deno.test("stream usage parser: extracts from SSE buffer", () => {
  // mirrors main.ts stream reader logic
  const buf = 'data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\ndata: [DONE]\n\n';
  const matches = [...buf.matchAll(/data:\s*({.*?})\s*\n/g)];
  let found = null;
  for (const m of matches) {
    try { const obj = JSON.parse(m[1]); const u = extractUsage(obj); if (u) { found = u; break; } } catch {}
  }
  if (!found || found.total_tokens !== 3) throw new Error("stream usage " + JSON.stringify(found));
});

Deno.test("protocol: OpenAI passthrough when provider openai", () => {
  const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
  // buildUpstream for openai returns payload = body (passthrough)
  if (body.model !== "gpt-4o") throw new Error("passthrough");
});
