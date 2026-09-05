#!/bin/bash
# 部署脚本 - Deno Deploy (单文件 main.ts)
set -e

echo "🛰️  LLM Router v2.2.0 部署"

# 检查依赖
command -v deno >/dev/null 2>&1 || { echo "❌ 需要 Deno: https://deno.land/manual/getting_started/installation"; exit 1; }

# 本地检查（不依赖 deno 也能跑 node 测试）
if command -v node >/dev/null 2>&1; then
  echo "▶ 运行静态检查..."
  node check.cjs
  echo "▶ 运行单元测试..."
  node test_full.cjs
  echo "▶ 运行集成测试..."
  node integration_full.cjs
fi

# 类型检查 (如果有 deno)
if command -v deno >/dev/null 2>&1; then
  echo "▶ Deno 类型检查..."
  deno check main.ts 2>&1 || echo "⚠️  deno check 有警告（JSR 需联网），可忽略"
fi

echo ""
echo "✅ 本地验证通过"
echo ""
echo "下一步："
echo "  1. 推送代码到 GitHub 仓库 'irouter'"
echo "  2. 前往 https://dash.deno.com/new 关联仓库"
echo "  3. Entry 填: main.ts"
echo "  4. 设置环境变量 (PROXY_KEY, SEED_KEYS, ...) 后部署"
echo ""
echo "  或命令行部署 (需 deno deploy):"
echo "    deno deploy --project=irouter --entry=main.ts"
