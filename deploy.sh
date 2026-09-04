#!/usr/bin/env bash
set -e
# LLM Router · Deno Deploy 一键部署
# 用法:
#   ./deploy.sh              # 交互式部署（推荐）
#   ./deploy.sh --ci         # 生成 GitHub Actions workflow（push 自动部署）
#   ./deploy.sh --dry-run    # 只打印命令，不执行

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${BLUE}[deploy]${NC} $*"; }
ok()   { echo -e "${GREEN}[done]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }

# --- flags ---
CI=0; DRY=0
for arg in "$@"; do
  case "$arg" in
    --ci) CI=1 ;;
    --dry-run|--dry) DRY=1 ;;
    -h|--help)
      echo "Usage: $0 [--ci] [--dry-run]"; exit 0 ;;
  esac
done

if [ "$CI" = "1" ]; then
  info "Generating GitHub Actions workflow..."
  mkdir -p .github/workflows
  cat > .github/workflows/deploy.yml <<'EOF'
name: Deploy to Deno Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to Deno Deploy
        uses: denoland/deployctl@v1
        with:
          project: ${{ secrets.DENO_PROJECT }}
          entrypoint: main.ts
          env: |
            PROXY_KEY=${{ secrets.PROXY_KEY }}
            OPENAI_KEYS=${{ secrets.OPENAI_KEYS }}
            ANTHROPIC_KEYS=${{ secrets.ANTHROPIC_KEYS }}
            GOOGLE_KEYS=${{ secrets.GOOGLE_KEYS }}
            GLM_KEYS=${{ secrets.GLM_KEYS }}
            ENABLE_USAGE=true
            MONTHLY_BUDGET=${{ secrets.MONTHLY_BUDGET || '0' }}
            RATE_LIMIT_RPM=${{ secrets.RATE_LIMIT_RPM || '60' }}
EOF
  ok "Written .github/workflows/deploy.yml"
  echo "Next: set secrets DENO_PROJECT, PROXY_KEY, *_KEYS in GitHub repo settings."
  exit 0
fi

command -v deno >/dev/null 2>&1 || { warn "Deno not found. Install: curl -fsSL https://deno.land/install.sh | sh"; exit 1; }

read -p "Deno Deploy project name [llm-router]: " PROJECT
PROJECT=${PROJECT:-llm-router}
read -p "Organization (leave blank for personal): " ORG

read -p "X-Proxy-Key (leave blank = open): " PROXY_KEY
read -p "OpenAI keys (comma): " OPENAI_KEYS
read -p "Anthropic keys (comma): " ANTHROPIC_KEYS
read -p "Google keys (comma): " GOOGLE_KEYS
read -p "GLM keys (comma): " GLM_KEYS
read -p "Monthly token budget (0 = disabled): " MONTHLY_BUDGET
MONTHLY_BUDGET=${MONTHLY_BUDGET:-0}
read -p "Rate limit RPM per IP [60]: " RATE_LIMIT_RPM
RATE_LIMIT_RPM=${RATE_LIMIT_RPM:-60}

cat > .env.deploy <<EOF
PROXY_KEY=$PROXY_KEY
OPENAI_KEYS=$OPENAI_KEYS
ANTHROPIC_KEYS=$ANTHROPIC_KEYS
GOOGLE_KEYS=$GOOGLE_KEYS
GLM_KEYS=$GLM_KEYS
ENABLE_USAGE=true
MONTHLY_BUDGET=$MONTHLY_BUDGET
RATE_LIMIT_RPM=$RATE_LIMIT_RPM
EOF

CMD="deployctl deploy --project=$PROJECT --entrypoint=main.ts --unstable-kv --env-file=.env.deploy"
[ -n "$ORG" ] && CMD="$CMD --org=$ORG"

if [ "$DRY" = "1" ]; then
  info "Dry run. Would execute:"
  echo "  deno $CMD"
  exit 0
fi

info "Ensuring logged in..."
deno login --prompt || true

info "Deploying project: $PROJECT"
if ! deno $CMD 2>&1 | tee /tmp/deploy.log; then
  if grep -q "already exists" /tmp/deploy.log; then
    warn "Project may already exist; trying to update..."
    deno $CMD || { echo "Deploy failed. See https://dash.deno.com"; exit 1; }
  else
    echo "Deploy failed."; exit 1
  fi
fi

ok "Deploy complete!"
echo -e "  Health:    https://$PROJECT.deno.dev/health"
echo -e "  API:       https://$PROJECT.deno.dev/v1/chat/completions"
echo -e "  Dashboard: https://$PROJECT.deno.dev/admin"
warn ".env.deploy contains secrets — add to .gitignore / delete after use."
