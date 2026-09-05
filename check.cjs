// 检查 main.ts 的导入清洁度（避免之前 Deno Deploy 的坑）
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/main.ts", "utf8");
const lines = src.split("\n");

console.log("== main.ts 静态检查 ==\n");

// 1. 唯一 import 应该是 Hono
const imports = lines.filter((l) => l.startsWith("import "));
console.log("Imports:");
imports.forEach((i) => console.log("  " + i));
const badImport = imports.find((i) => i.includes("modules.js") || i.includes("serve-static") || i.includes("hono/"));
if (badImport) { console.log("\n✗ 发现非法 import: " + badImport); process.exit(1); }
console.log("✓ 无 modules.js / serve-static / hono/ 子路径\n");

// 2. 无 port 选项
if (src.includes("Deno.serve({ port:")) { console.log("✗ Deno.serve 带 port"); process.exit(1); }
console.log("✓ Deno.serve 无 port 选项");

// 3. serveStatic 未使用
if (src.includes("serveStatic")) { console.log("✗ 仍引用 serveStatic"); process.exit(1); }
console.log("✓ 无 serveStatic 引用");

// 4. 文件行数
console.log(`✓ main.ts 行数: ${lines.length}`);

// 5. 关键功能标记
const checks = [
  ["内置供应商目录", "BUILTIN"],
  ["KV 懒加载", "async function getKv"],
  ["配置中心", "class ConfigStore"],
  ["延迟统计", "class LatencyStats"],
  ["请求日志", "class RequestLog"],
  ["路由规则", "class RouteRules"],
  ["ProxyKey 管理", "class ProxyKeyManager"],
  ["Webhook 告警", "class WebhookNotifier"],
  ["协议转换-请求", "function buildUpstream"],
  ["协议转换-响应", "function normalizeResponse"],
  ["健康检查", "healthCheckOnce"],
  ["预算拦截", "DAILY_TOKEN_BUDGET"],
  ["配置导出", "exportConfig"],
  ["Dashboard 内联", "DASHBOARD_HTML"],
  ["/v1/models", '"/v1/models"'],
  ["/v1/chat/completions", '"/v1/chat/completions"'],
  ["供应商 CRUD API", '"/admin/api/providers"'],
  ["Keys API", '"/admin/api/providers/:id/keys"'],
  ["连通性测试", '"/admin/api/providers/:id/test"'],
  ["路由规则 API", '"/admin/api/routes"'],
  ["ProxyKeys API", '"/admin/api/proxy-keys"'],
  ["延迟统计 API", '"/admin/api/stats/latency"'],
  ["用量统计 API", '"/admin/api/stats/usage"'],
  ["日志 API", '"/admin/api/logs"'],
  ["健康检查 API", '"/admin/api/health/check"'],
  ["告警 API", '"/admin/api/alerts"'],
  ["配置导入导出 API", '"/admin/api/config/import"'],
];
let ok = 0;
for (const [name, marker] of checks) {
  const found = src.includes(marker);
  console.log(`${found ? "✓" : "✗"} ${name} (${marker})`);
  if (found) ok++;
}
console.log(`\n功能覆盖: ${ok}/${checks.length}`);
if (ok < checks.length) process.exit(1);

// 6. Dashboard 6 Tab
const tabs = ["providers", "keys", "latency", "usage", "logs", "routes"];
for (const t of tabs) {
  if (!src.includes(`p-${t}`)) { console.log(`✗ Dashboard 缺少 Tab: ${t}`); process.exit(1); }
}
console.log("✓ Dashboard 6 Tab 完整 (providers/keys/latency/usage/logs/routes)");

// 7. 协议覆盖 (buildUpstream 中的 if 分支)
for (const p of ["openai", "glm", "anthropic", "google"]) {
  if (!src.includes(`protocol === "${p}"`)) { console.log(`✗ 协议 ${p} 未实现`); process.exit(1); }
}
console.log("✓ 4 种协议 (openai/anthropic/google/glm)");

console.log("\n== 全部静态检查通过 ==");
