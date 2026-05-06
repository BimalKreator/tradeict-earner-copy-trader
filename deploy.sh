#!/usr/bin/env bash
# Production deploy: pulls, installs, regenerates Prisma, rebuilds backend
# and frontend, restarts PM2, and saves the process list.
#
# Idempotent. Fails loud and early — if any step errors out we DO NOT
# proceed to the next. This stops the "build silently ran on old code"
# class of bugs.
#
# Usage (from repo root):
#   bash deploy.sh
#
# Optional env:
#   FRONTEND_PORT=3000           # next start --port
#   SKIP_FRONTEND=1              # only deploy backend
#   SKIP_BACKEND=1               # only deploy frontend
#   STASH_LOCAL=1                # `git stash` instead of `git checkout --` for local edits

set -euo pipefail

# Resolve repo root (the directory this script lives in)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# Colour helpers (only when stdout is a TTY)
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_END=$'\033[0m'
else
  C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_END=""
fi
log()  { printf "%s[deploy]%s %s\n" "$C_BOLD" "$C_END" "$*"; }
ok()   { printf "%s[deploy]%s %s%s%s\n" "$C_BOLD" "$C_END" "$C_GREEN" "$*" "$C_END"; }
warn() { printf "%s[deploy]%s %s%s%s\n" "$C_BOLD" "$C_END" "$C_YELLOW" "$*" "$C_END"; }
die()  { printf "%s[deploy]%s %s%s%s\n" "$C_BOLD" "$C_END" "$C_RED" "FATAL: $*" "$C_END" >&2; exit 1; }

# ── 0. Pre-flight ────────────────────────────────────────────────────────────
command -v git  >/dev/null || die "git not found"
command -v npm  >/dev/null || die "npm not found"
command -v node >/dev/null || die "node not found"
command -v pm2  >/dev/null || die "pm2 not found (install with: npm i -g pm2)"

log "repo: $REPO_ROOT"
log "node: $(node --version)  npm: $(npm --version)  pm2: $(pm2 --version)"

# ── 1. Resolve any uncommitted server-side edits, then pull ──────────────────
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "working tree is dirty — local edits will block git pull"
  if [ "${STASH_LOCAL:-0}" = "1" ]; then
    log "STASH_LOCAL=1 → stashing local edits"
    git stash push -u -m "deploy.sh auto-stash $(date -Iseconds)"
  else
    log "discarding local edits with: git checkout -- ."
    log "(set STASH_LOCAL=1 to stash instead of discard)"
    git checkout -- .
  fi
fi

log "git fetch + pull origin main"
git fetch origin
git checkout main
git pull --ff-only origin main || die "git pull failed (see above)"

DEPLOY_SHA="$(git rev-parse --short HEAD)"
ok "now at commit $DEPLOY_SHA — $(git log -1 --pretty=%s)"

# ── 2. Backend build ─────────────────────────────────────────────────────────
if [ "${SKIP_BACKEND:-0}" != "1" ]; then
  log "── backend build ──"
  cd "$REPO_ROOT/backend"

  log "npm install"
  npm install

  if [ -f prisma/schema.prisma ]; then
    log "prisma generate"
    npx prisma generate
  fi

  log "rm -rf dist && npm run build"
  rm -rf dist
  npm run build

  # Sanity check: confirm the new code actually landed in dist/
  if grep -q "DEBUG_AUTH" dist/services/exchangeService.js 2>/dev/null; then
    ok "dist/services/exchangeService.js contains DEBUG_AUTH (debug logs live)"
  else
    warn "dist/services/exchangeService.js does NOT contain DEBUG_AUTH — debug logs may not be in this revision"
  fi

  cd "$REPO_ROOT"
fi

# ── 3. Frontend build ────────────────────────────────────────────────────────
if [ "${SKIP_FRONTEND:-0}" != "1" ]; then
  log "── frontend build ──"
  cd "$REPO_ROOT/frontend"

  log "npm install"
  npm install

  log "rm -rf .next && npm run build"
  rm -rf .next
  npm run build

  # Sanity check: confirm the new pages were compiled
  for p in dashboard/billing dashboard/trades admin/revenue; do
    if [ -d ".next/server/app/$p" ]; then
      ok "frontend route /$p compiled"
    else
      warn "frontend route /$p MISSING from .next/ — page may not be on this revision"
    fi
  done

  cd "$REPO_ROOT"
fi

# ── 4. Restart PM2 (start if not running) ────────────────────────────────────
log "── pm2 startOrReload ──"
pm2 startOrReload "$REPO_ROOT/ecosystem.config.cjs" --update-env
pm2 save

log "current pm2 process list:"
pm2 list

ok "deploy complete @ $DEPLOY_SHA"
log "tail logs with:  pm2 logs --lines 40"
