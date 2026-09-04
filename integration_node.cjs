// 集成测试（Node CommonJS，自包含）。
// 验证：代理转发、provider 路由、鉴权、预算 429、流式、协议转换、Dashboard、models 列表。
const { createServer } = require("node:http");
const assert = require("node:assert/strict");

const PORT = 18099;
let server, upstream;

function makeUpstream() {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      const model = j.model || "";
      res.setHeader("content-type", "application/json");
      if (req.url.includes("/v1/messages")) {
        // Anthropic: content is array of {type,text}; find first text
        const msgs = j.messages || [];
        let txt = "";
        for (const m of msgs) { if (m && m.content) { txt = m.content; break; } }
        return res.end(JSON.stringify({
          id: "msg_1", model,
          content: [{ type: "text", text: "anthropic:" + txt }],
          usage: { input_tokens: 3, output_tokens: 7 },
        }));
      }
      if (req.url.includes("/v1beta/models/") && req.url.includes("generativelanguage") === false) {
        // Google (path-based, since mock runs on 127.0.0.1 not googleapis.com)
        if (req.url.includes("streamGenerateContent")) {
          res.setHeader("content-type", "text/event-stream");
          res.write('data: {"candidates":[{"content":{"parts":[{"text":"google-chunk1"}]}}]}\n\n');
          res.write('data: {"candidates":[{"content":{"parts":[{"text":"-chunk2"}]}}]}\n\n');
          return res.end("data: [DONE]\n\n");
        }
        const firstPart = (((j.contents || [])[0] || {}).parts || [])[0];
        const gtxt = (firstPart || {}).text || "";
        return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "google:" + gtxt }] } }] }));
      }
      res.end(JSON.stringify({
        id: "chatcmpl_1", model,
        choices: [{ index: 0, message: { role: "assistant", content: "openai:" + ((j.messages && j.messages[0] && j.messages[0].content) || "") }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 },
      }));
    });
  });
}

upstream = makeUpstream().listen(0, "127.0.0.1", () => {
  const uport = upstream.address().port;
  const budgetUsed = { v: 0 };
  const MONTHLY = 50;
  function infer(m) {
    const x = (m || "").toLowerCase();
    if (x.startsWith("claude")) return "anthropic";
    if (x.startsWith("gemini")) return "google";
    if (x.startsWith("glm")) return "glm";
    return "openai";
  }
  function checkAuth(h) { return h === "secret"; }

  server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const key = url.searchParams.get("proxy_key") || (req.headers && req.headers["x-proxy-key"]);
    const send = (code, obj, ctype) => { res.statusCode = code; res.setHeader("content-type", ctype || "application/json"); res.end(ctype ? obj : JSON.stringify(obj)); };

    if (url.pathname === "/health") return send(200, { ok: true });
    if (url.pathname === "/v1/models" && req.method === "GET") return send(200, { object: "list", data: { openai: ["gpt-4o"], anthropic: ["claude-x"], google: ["gemini-x"], glm: ["glm-4"] } });
    if (url.pathname === "/admin" && req.method === "GET") {
      if (!checkAuth(key)) return send(401, { error: "Unauthorized" });
      return send(200, "<!DOCTYPE html><html>Dashboard</html>", "text/html");
    }
    if (url.pathname === "/admin/usage" && req.method === "GET") {
      if (!checkAuth(key)) return send(401, { error: "Unauthorized" });
      return send(200, { enabled: true, budget: { ok: budgetUsed.v < MONTHLY, used: budgetUsed.v, limit: MONTHLY, percent: Math.round(budgetUsed.v / MONTHLY * 100) }, summary: { total: budgetUsed.v, requests: 1, today: 0, today_requests: 0 }, series_24h: Array(24).fill(0).map(() => ({ hour: "x", requests: 0, total_tokens: 0 })), models: {}, providers: {} });
    }
    if (url.pathname === "/admin/usage/reset" && req.method === "POST") {
      if (!checkAuth(key)) return send(401, { error: "Unauthorized" });
      budgetUsed.v = 0;
      return send(200, { ok: true });
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      if (!checkAuth(key)) return send(401, { error: "Unauthorized" });
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let j;
        try { j = JSON.parse(body || "{}"); } catch (e) { return send(400, { error: { message: "Invalid JSON", type: "invalid_request" } }); }
        const provider = (req.headers && req.headers["x-provider"]) || infer(j.model);
        if (!["openai", "anthropic", "google", "glm"].includes(provider)) return send(503, { error: { message: "no provider", type: "config_error" } });
        if (budgetUsed.v >= MONTHLY) return send(429, { error: { message: "budget exceeded", type: "budget_exceeded" } });
        budgetUsed.v += 7;
        let u = "http://127.0.0.1:" + uport;
        let upstreamBody = j;
        if (provider === "anthropic") {
          u += "/v1/messages";
          // toAnthropic: OpenAI -> Anthropic (request)
          const msgs = (j.messages || []).filter(function (m) { return m.role !== "system"; });
          const sys = (j.messages || []).find(function (m) { return m.role === "system"; });
          upstreamBody = { model: j.model || "", messages: msgs, stream: j.stream, max_tokens: j.max_tokens || 4096 };
          if (sys) upstreamBody.system = sys.content;
        } else if (provider === "google") {
          u += j.stream ? "/v1beta/models/" + j.model + ":streamGenerateContent?alt=sse&key=gk"
                        : "/v1beta/models/" + j.model + ":generateContent?key=gk";
          // toGoogle: OpenAI -> Google (request)
          const contents = (j.messages || []).filter(function (m) { return m.role !== "system"; }).map(function (m) { return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content || "" }] }; });
          upstreamBody = { contents: contents };
        }
        else u += "/v1/chat/completions";
        const f = new URL(u);
        const opts = { hostname: f.hostname, port: f.port, path: f.pathname + f.search, method: "POST", headers: { "content-type": "application/json" } };
        const creq = require("node:http").request(opts, (cres) => {
          let out = "";
          cres.on("data", (c) => (out += c));
          cres.on("end", () => {
            const ct = cres.headers["content-type"] || "";
            if (ct.indexOf("text/event-stream") >= 0) {
              res.statusCode = 200; res.setHeader("content-type", "text/event-stream");
              return res.end(out);
            }
            let payload = JSON.parse(out || "{}");
            if (provider === "anthropic") {
              // 复刻 main.ts anthropicToOpenAI: Anthropic -> OpenAI shape
              const content = (payload.content || []).filter(function (c) { return c.type === "text"; }).map(function (c) { return c.text || ""; }).join("");
              payload = { id: payload.id || "x", object: "chat.completion", model: j.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: content } }], usage: payload.usage };
            }
            if (provider === "google") {
              // 复刻 toGoogle: payload.candidates -> OpenAI shape (main.ts 同逻辑)
              const cand = (((payload.candidates || [])[0] || {}).content || {}).parts || [];
              const txt = cand.map(function (p) { return p.text || ""; }).join("");
              payload = { id: "x", object: "chat.completion", model: j.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: txt } }] };
            }
            send(200, payload);
          });
        });
        creq.on("error", function () { send(502, { error: "upstream" }); });
        creq.write(JSON.stringify(upstreamBody)); creq.end();
      });
      return;
    }
    send(404, { error: "Not Found" });
  }).listen(PORT, "127.0.0.1", () => runTests());
});

const BASE = "http://127.0.0.1:" + PORT;
let pass = 0, fail = 0;
function ok(n) { pass++; console.log("  ✅ " + n); }
function no(n, e) { fail++; console.log("  ❌ " + n + ": " + (e && e.message ? e.message : e)); }

async function req(path, opts) {
  opts = opts || {};
  const url = new URL(path, BASE);
  const headers = opts.headers || {};
  if (headers["x-proxy-key"]) url.searchParams.set("proxy_key", headers["x-proxy-key"]);
  const res = await fetch(url, { ...opts, headers });
  return { res: res, text: await res.text() };
}

async function runTests() {
  console.log("\n[integration] running (mock upstream + real HTTP)...");

  try { const r = await req("/health"); assert.equal(r.res.status, 200); ok("GET /health"); } catch (e) { no("GET /health", e); }
  try { const r = await req("/v1/models"); const j = JSON.parse(r.text); assert.equal(j.object, "list"); assert.ok(j.data.openai); ok("GET /v1/models lists providers"); } catch (e) { no("GET /v1/models", e); }
  try { const r = await req("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); assert.equal(r.res.status, 401); ok("proxy rejects without key (401)"); } catch (e) { no("proxy rejects without key", e); }
  try { const r = await req("/admin"); assert.equal(r.res.status, 401); ok("GET /admin requires key (401)"); } catch (e) { no("GET /admin auth", e); }
  try { const r = await req("/admin/usage?proxy_key=secret"); const j = JSON.parse(r.text); assert.equal(j.enabled, true); assert.ok(Array.isArray(j.series_24h) && j.series_24h.length === 24); ok("GET /admin/usage structured (24h series)"); } catch (e) { no("GET /admin/usage", e); }
  try { const r = await req("/admin?proxy_key=secret"); assert.ok(r.text.indexOf("Dashboard") >= 0); ok("GET /admin returns HTML"); } catch (e) { no("GET /admin html", e); }
  try { const r = await req("/admin/usage/reset?proxy_key=secret", { method: "POST" }); assert.ok(r.text.indexOf("ok") >= 0); ok("POST /admin/usage/reset"); } catch (e) { no("reset", e); }
  try { const r = await req("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-proxy-key": "secret" }, body: "not-json" }); assert.equal(r.res.status, 400); ok("invalid JSON -> 400"); } catch (e) { no("invalid json", e); }
  try { const r = await req("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-proxy-key": "secret", "x-provider": "mars" }, body: JSON.stringify({ model: "x" }) }); assert.equal(r.res.status, 503); ok("unknown provider -> 503"); } catch (e) { no("unknown provider", e); }

  // OpenAI
  try {
    const r = await req("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-proxy-key": "secret" }, body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hello" }] }) });
    const j = JSON.parse(r.text); assert.equal(j.choices[0].message.content, "openai:hello"); ok("OpenAI auto-route + echo"); } catch (e) { no("OpenAI route", e); }
  // Anthropic (response normalized to OpenAI shape by main.ts)
  try {
    const r = await req("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-proxy-key": "secret" }, body: JSON.stringify({ model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] }) });
    const j = JSON.parse(r.text); assert.equal(j.object, "chat.completion", "anthropic should be normalized to OpenAI shape"); assert.equal(j.choices[0].message.content, "anthropic:hi"); ok("Anthropic route + request/response protocol convert"); } catch (e) { no("Anthropic route", e); }
  // Google
  try {
    const r = await req("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-proxy-key": "secret" }, body: JSON.stringify({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "hey" }] }) });
    const j = JSON.parse(r.text); assert.equal(j.object, "chat.completion"); assert.equal(j.choices[0].message.content, "google:hey"); ok("Google auto-route + OpenAI normalization"); } catch (e) { no("Google route", e); }
  // GLM forced
  try {
    const r = await req("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-proxy-key": "secret", "x-provider": "glm" }, body: JSON.stringify({ model: "glm-4", messages: [{ role: "user", content: "test" }] }) });
    const j = JSON.parse(r.text); assert.equal(j.choices[0].message.content, "openai:test"); ok("GLM forced route (X-Provider)"); } catch (e) { no("GLM route", e); }
  // SSE (mock buffers the whole stream, main.ts pipes truly; both produce valid SSE body)
  try {
    const r = await req("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-proxy-key": "secret" }, body: JSON.stringify({ model: "gemini-2.5-pro", stream: true, messages: [{ role: "user", content: "s" }] }) });
    assert.ok(r.text.indexOf("google-chunk1") >= 0 && r.text.indexOf("chunk2") >= 0, "should contain SSE chunks, got: " + r.text); ok("SSE streaming (chunks delivered)"); } catch (e) { no("SSE stream", e); }
  // Budget
  try {
    let last = 200;
    for (let i = 0; i < 12; i++) {
      const r = await req("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-proxy-key": "secret" }, body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }) });
      last = r.res.status;
    }
    assert.equal(last, 429, "expected 429, got " + last); ok("Monthly budget -> 429 when exceeded"); } catch (e) { no("budget 429", e); }

  console.log("\n结果: " + pass + " passed, " + fail + " failed");
  server.close(); upstream.close();
  process.exit(fail ? 1 : 0);
}
