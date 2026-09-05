import { Hono } from "hono";
import { serveStatic } from "hono/middleware/serve-static";

// ---------- Types ----------
type Role = "system" | "user" | "assistant" | "tool";
interface Msg {
  role: Role;
  content?: string | unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
}
interface ChatReq {
  model?: string;
  messages?: Msg[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown;
  [k: string]: unknown;
}

// ---------- Env ----------
const ENV = {
  PROXY_KEY: (Deno.env.get("PROXY_KEY") || "").trim(),
  OPENAI_KEYS: (Deno.env.get("OPENAI_KEYS") || "").split(",").map((s) => s.trim()).filter(Boolean),
  ANTHROPIC_KEYS: (Deno.env.get("ANTHROPIC_KEYS") || "").split(",").map((s) => s.trim()).filter(Boolean),
  GOOGLE_KEYS: (Deno.env.get("GOOGLE_KEYS") || "").split(",").map((s) => s.trim()).filter(Boolean),
  GLM_KEYS: (Deno.env.get("GLM_KEYS") || "").split(",").map((s) => s.trim()).filter(Boolean),
  DEFAULT_PROVIDER: (Deno.env.get("DEFAULT_PROVIDER") || "openai").toLowerCase(),
  REQUEST_TIMEOUT_MS: Number(Deno.env.get("REQUEST_TIMEOUT_MS") || "120000"),
  ENABLE_USAGE: (Deno.env.get("ENABLE_USAGE") || "true").toLowerCase() === "true",
  MONTHLY_BUDGET: Number(Deno.env.get("MONTHLY_BUDGET") || "0"), // tokens; 0 = disabled
  BUDGET_INCLUDE_INPUT: (Deno.env.get("BUDGET_INCLUDE_INPUT") || "true").toLowerCase() === "true",
  RATE_LIMIT_RPM: Number(Deno.env.get("RATE_LIMIT_RPM") || "60"), // per IP
};

const kv: Deno.Kv | null = ENV.ENABLE_USAGE ? await Deno.openKv().catch(() => null) : null;

// ---------- Logger ----------
function log(level: "info" | "warn" | "error", msg: string, data: Record<string, unknown> = {}) {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, level, msg, ...data }));
}

// ---------- Provider routing ----------
function inferProvider(model = ""): string {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("glm")) return "glm";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("chatgpt")) return "openai";
  return ENV.DEFAULT_PROVIDER;
}

// ---------- Key rotation ----------
const keyCounters: Record<string, number> = {};
function pickKey(provider: string): string | null {
  const list = (ENV as Record<string, string[]>)[`${provider.toUpperCase()}_KEYS`] || [];
  if (!list.length) return null;
  const i = (keyCounters[provider] = (keyCounters[provider] + 1) || 0) % list.length;
  return list[i];
}

// ---------- Auth ----------
function checkAuth(req: Request): boolean {
  if (!ENV.PROXY_KEY) return true; // no key configured = open
  const h = req.headers.get("x-proxy-key") || new URL(req.url).searchParams.get("proxy_key") || "";
  return h === ENV.PROXY_KEY;
}

// ---------- Budget ----------
function budgetKey(): string {
  const d = new Date();
  return `budget:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
async function checkBudget(): Promise<{ ok: boolean; used: number; limit: number }> {
  if (!ENV.MONTHLY_BUDGET || !kv) return { ok: true, used: 0, limit: ENV.MONTHLY_BUDGET };
  const used = (await kv.get<number>([budgetKey()])).value || 0;
  return { ok: used < ENV.MONTHLY_BUDGET, used, limit: ENV.MONTHLY_BUDGET };
}

// ---------- Rate limit (token bucket per IP, in-memory) ----------
const rlStore = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string): boolean {
  if (ENV.RATE_LIMIT_RPM <= 0) return true;
  const now = Date.now();
  const e = rlStore.get(ip);
  if (!e || e.resetAt < now) {
    rlStore.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  e.count++;
  return e.count <= ENV.RATE_LIMIT_RPM;
}

// ---------- Usage recording ----------
function dayKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function hourKey(d = new Date()): string {
  return `${dayKey(d)}T${String(d.getUTCHours()).padStart(2, "0")}`;
}
interface UsagePoint {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
function extractUsage(payload: Record<string, unknown>): UsagePoint | null {
  const u = payload?.usage as Record<string, unknown> | undefined;
  if (!u) return null;
  // OpenAI / GLM style
  if ("total_tokens" in u) {
    return {
      prompt_tokens: Number(u.prompt_tokens || 0),
      completion_tokens: Number(u.completion_tokens || 0),
      total_tokens: Number(u.total_tokens || 0),
    };
  }
  // Anthropic style: input_tokens / output_tokens
  if ("input_tokens" in u) {
    const p = Number(u.input_tokens || 0);
    const c = Number(u.output_tokens || 0);
    return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
  }
  return null;
}
async function recordUsage(provider: string, model: string, pt: number, ct: number, total: number) {
  if (!kv || !total) return;
  const day = dayKey();
  const hour = hourKey();
  const a = ENV.BUDGET_INCLUDE_INPUT ? total : ct;
  const ops: Deno.AtomicOperation = kv.atomic();
  // totals
  ops.sum(["usage", "total", "requests"], 1n)
    .sum(["usage", "total", "prompt_tokens"], BigInt(pt))
    .sum(["usage", "total", "completion_tokens"], BigInt(ct))
    .sum(["usage", "total", "total_tokens"], BigInt(total))
    // monthly budget (charged amount)
    .sum([budgetKey()], BigInt(a))
    // day
    .sum(["usage", "day", day, "requests"], 1n)
    .sum(["usage", "day", day, "total_tokens"], BigInt(total))
    // hour (time series)
    .sum(["usage", "hour", hour, "requests"], 1n)
    .sum(["usage", "hour", hour, "total_tokens"], BigInt(total))
    // by model
    .sum(["usage", "model", model, "requests"], 1n)
    .sum(["usage", "model", model, "total_tokens"], BigInt(total))
    // by provider
    .sum(["usage", "provider", provider, "requests"], 1n)
    .sum(["usage", "provider", provider, "total_tokens"], BigInt(total));
  await ops.commit().catch(() => {});
}

// ---------- Protocol conversion ----------
function toAnthropic(body: ChatReq): { model: string; messages: Msg[]; system?: string; stream?: boolean; max_tokens: number; temperature?: number; tools?: unknown } {
  const msgs = (body.messages || []).filter((m) => m.role !== "system");
  const system = (body.messages || []).find((m) => m.role === "system")?.content as string | undefined;
  return {
    model: body.model || "",
    messages: msgs.map((m) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user",
      content: (m.content as string) || "",
    })),
    ...(system ? { system } : {}),
    stream: body.stream,
    max_tokens: body.max_tokens || 4096,
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.tools ? { tools: body.tools } : {}),
  };
}
function toGoogle(body: ChatReq, apiKey: string): { url: string; payload: Record<string, unknown> } {
  const contents = (body.messages || []).filter((m) => m.role !== "system").map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: (m.content as string) || "" }],
  }));
  const system = (body.messages || []).find((m) => m.role === "system")?.content as string | undefined;
  const payload: Record<string, unknown> = {
    contents,
    generationConfig: { temperature: body.temperature, maxOutputTokens: body.max_tokens },
  };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:${body.stream ? "streamGenerateContent" : "generateContent"}?alt=sse&key=${apiKey}`;
  return { url, payload };
}

// ---------- Upstream ----------
interface Upstream {
  url: string;
  headers: Record<string, string>;
  payload?: unknown;
  method: string;
}
function buildUpstream(provider: string, body: ChatReq, key: string): Upstream {
  switch (provider) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        payload: toAnthropic(body),
      };
    case "google": {
      const { url, payload } = toGoogle(body, key);
      return { url, method: "POST", headers: { "content-type": "application/json" }, payload };
    }
    case "glm":
      return {
        url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        payload: body,
      };
    default: // openai + fallback
      return {
        url: "https://api.openai.com/v1/chat/completions",
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        payload: body,
      };
  }
}

// normalize Anthropic response -> OpenAI shape
function anthropicToOpenAI(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const content = (payload.content as Array<{ type: string; text?: string }>) || [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text || "").join("");
  const stop = (payload.stop_reason as string) === "tool_use" ? "tool_calls" : "stop";
  return {
    id: (payload.id as string) || crypto.randomUUID(),
    object: "chat.completion",
    model,
    choices: [{ index: 0, finish_reason: stop, message: { role: "assistant", content: text } }],
    usage: payload.usage,
  };
}

// normalize non-stream Google response to OpenAI shape
function googleToOpenAI(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const cands = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates || [];
  const text = cands.map((c) => c.content?.parts?.map((p) => p.text || "").join("") || "").join("");
  return {
    id: crypto.randomUUID(),
    object: "chat.completion",
    model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
  };
}

// ---------- App ----------
const app = new Hono();

app.get("/", (c) => c.json({ ok: true, service: "llm-router", version: "1.3.0" }));

// admin dashboard (static html)
app.get("/admin", async (c) => {
  if (!checkAuth(c.req.raw)) return c.text("Unauthorized", 401);
  try {
    const path = import.meta.resolve("./public/usage.html");
    const file = await Deno.readTextFile(path.replace("file://", ""));
    return c.html(file);
  } catch {
    return c.text("Dashboard not found. Ensure public/usage.html exists.", 500);
  }
});

// usage API
app.get("/admin/usage", async (c) => {
  if (!checkAuth(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  if (!kv) return c.json({ enabled: false, reason: "KV unavailable" });
  const day = dayKey();
  const today = (await kv.get<number>(["usage", "day", day, "total_tokens"])).value || 0;
  const dayReq = (await kv.get<number>(["usage", "day", day, "requests"])).value || 0;
  const total = (await kv.get<number>(["usage", "total", "total_tokens"])).value || 0;
  const totalReq = (await kv.get<number>(["usage", "total", "requests"])).value || 0;

  // time series: last 24 hours
  const series: Array<{ hour: string; requests: number; total_tokens: number }> = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(Date.now() - i * 3600_000);
    const hk = hourKey(d);
    const [tk, tr] = await Promise.all([
      kv.get<number>(["usage", "hour", hk, "total_tokens"]),
      kv.get<number>(["usage", "hour", hk, "requests"]),
    ]);
    series.push({ hour: hk, requests: tr.value || 0, total_tokens: tk.value || 0 });
  }

  // by model & provider
  const modelEntries = await kv.list<number>({ prefix: ["usage", "model"] });
  const providerEntries = await kv.list<number>({ prefix: ["usage", "provider"] });
  const models: Record<string, { requests: number; total_tokens: number }> = {};
  const providers: Record<string, { requests: number; total_tokens: number }> = {};
  for await (const e of modelEntries) {
    const name = (e.key as string[]).slice(-2).join(":");
    if (name.endsWith(":requests")) {
      const m = name.slice(0, -":requests".length);
      models[m] = models[m] || { requests: 0, total_tokens: 0 };
      models[m].requests = e.value || 0;
    } else if (name.endsWith(":total_tokens")) {
      const m = name.slice(0, -":total_tokens".length);
      models[m] = models[m] || { requests: 0, total_tokens: 0 };
      models[m].total_tokens = e.value || 0;
    }
  }
  for await (const e of providerEntries) {
    const name = (e.key as string[]).slice(-2).join(":");
    if (name.endsWith(":requests")) {
      const p = name.slice(0, -":requests".length);
      providers[p] = providers[p] || { requests: 0, total_tokens: 0 };
      providers[p].requests = e.value || 0;
    } else if (name.endsWith(":total_tokens")) {
      const p = name.slice(0, -":total_tokens".length);
      providers[p] = providers[p] || { requests: 0, total_tokens: 0 };
      providers[p].total_tokens = e.value || 0;
    }
  }

  const budget = await checkBudget();
  return c.json({
    enabled: true,
    kv_backend: "deno-kv",
    budget: { ...budget, percent: budget.limit ? Math.round((budget.used / budget.limit) * 100) : null },
    summary: { total, requests: totalReq, today, today_requests: dayReq },
    series_24h: series,
    models,
    providers,
  });
});

app.post("/admin/usage/reset", async (c) => {
  if (!checkAuth(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  if (!kv) return c.json({ ok: false, reason: "KV unavailable" }, 503);
  const iter = kv.list({ prefix: ["usage"] });
  const deletes: Promise<unknown>[] = [];
  for await (const e of iter) deletes.push(kv.delete(e.key));
  await Promise.all(deletes);
  return c.json({ ok: true, deleted: deletes.length });
});

// static (for any other assets)
app.use("/static/*", serveStatic({ root: "./public" }));

// main proxy
app.post("/v1/chat/completions", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(ip)) return c.json({ error: { message: "Rate limit exceeded", type: "rate_limit" } }, 429);

  const budget = await checkBudget();
  if (!budget.ok) {
    return c.json(
      { error: { message: `Monthly budget exceeded (${budget.used}/${budget.limit} tokens). Reset at month end.`, type: "budget_exceeded" } },
      429,
    );
  }

  let body: ChatReq;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON", type: "invalid_request" } }, 400);
  }
  const provider = (c.req.header("x-provider") || inferProvider(body.model)).toLowerCase();
  const key = pickKey(provider);
  if (!key) return c.json({ error: { message: `No API key configured for provider: ${provider}`, type: "config_error" } }, 503);

  const up = buildUpstream(provider, body, key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ENV.REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(up.url, {
      method: up.method,
      headers: up.headers,
      body: up.payload ? JSON.stringify(up.payload) : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    // streaming: pipe through
    if (body.stream && res.body) {
      // record usage on stream end (best-effort, parse SSE for usage if present)
      const reader = res.body.getReader();
      const stream = new ReadableStream({
        async start(controller) {
          let buf = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = new TextDecoder().decode(value);
              buf += chunk;
              controller.enqueue(value);
            }
            // try parse final usage from accumulated SSE
            const match = buf.match(/data:\s*({.*?})\s*\n/g);
            if (match && kv) {
              for (const m of match) {
                try {
                  const obj = JSON.parse(m.replace(/^data:\s*/, ""));
                  const u = extractUsage(obj);
                  if (u) {
                    await recordUsage(provider, body.model || "unknown", u.prompt_tokens, u.completion_tokens, u.total_tokens);
                    break;
                  }
                } catch {}
              }
            }
          } catch (e) {
            log("warn", "stream read error", { err: String(e) });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, { status: res.status, headers: { "content-type": res.headers.get("content-type") || "text/event-stream" } });
    }

    const text = await res.text();
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(text); } catch {}
    const usage = extractUsage(payload);
    if (usage) await recordUsage(provider, body.model || "unknown", usage.prompt_tokens, usage.completion_tokens, usage.total_tokens);

    // normalize Google non-stream to OpenAI shape
    const out = provider === "anthropic" ? anthropicToOpenAI(payload, body.model || "")
      : provider === "google" && !body.stream ? googleToOpenAI(payload, body.model || "")
      : payload;
    return new Response(JSON.stringify(out), { status: res.status, headers: { "content-type": "application/json" } });
  } catch (e) {
    clearTimeout(timer);
    log("error", "upstream request failed", { provider, err: String(e) });
    return c.json({ error: { message: `Upstream error: ${String(e)}`, type: "upstream_error" } }, 502);
  }
});

// models list (aggregated)
app.get("/v1/models", (c) => {
  const models: Record<string, string[]> = {};
  if (ENV.OPENAI_KEYS.length) models.openai = ["gpt-4o", "gpt-4o-mini", "o3-mini", "o4-mini"];
  if (ENV.ANTHROPIC_KEYS.length) models.anthropic = ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-20250514"];
  if (ENV.GOOGLE_KEYS.length) models.google = ["gemini-2.5-pro", "gemini-2.5-flash"];
  if (ENV.GLM_KEYS.length) models.glm = ["glm-4-plus", "glm-4-air"];
  return c.json({ object: "list", data: models });
});

// health
app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

// 404
app.notFound((c) => c.json({ error: "Not Found", path: c.req.path }, 404));

Deno.serve({ port: Number(Deno.env.get("PORT") || 8000) }, app.fetch);
log("info", "llm-router started", { enable_usage: ENV.ENABLE_USAGE, budget: ENV.MONTHLY_BUDGET || "disabled", rpm: ENV.RATE_LIMIT_RPM });
