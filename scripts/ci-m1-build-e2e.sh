#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

export PLAYWRIGHT_BROWSERS_PATH="${HOME}/Library/Caches/ms-playwright"

pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm test:e2e
pnpm test:packaging
