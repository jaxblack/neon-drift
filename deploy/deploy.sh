#!/usr/bin/env bash
#
# 把 NEON DRIFT 部署到 qlili.com/speed
#
#   bash deploy/deploy.sh
#
# 流程：本地构建 → rsync 到 /srv/speed/releases/<版本> → 原子切换 current 软链 → 冒烟测试。
# 采用和同机 besthome 一致的 releases + current 模式，回滚只需要把软链指回上一个版本。
#
set -euo pipefail

SSH_HOST="${SSH_HOST:-tencent-main}"
REMOTE_ROOT="${REMOTE_ROOT:-/srv/speed}"
BASE_PATH="${BASE_PATH:-/speed/}"
PUBLIC_URL="${PUBLIC_URL:-https://qlili.com/speed/}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

cd "$(dirname "$0")/.."

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------
# 1. 构建
# ---------------------------------------------------------------
say "构建（base=${BASE_PATH}）"
[ -d node_modules ] || npm ci
VITE_BASE_PATH="$BASE_PATH" npm run build

[ -f dist/index.html ] || die "dist/index.html 不存在，构建失败了"
# 构建产物必须带上子路径前缀，否则线上会 404
grep -q "${BASE_PATH}assets/" dist/index.html \
  || die "dist/index.html 里没有 ${BASE_PATH}assets/ 前缀，base 没生效"

# ---------------------------------------------------------------
# 2. 版本号：git 短 hash + 时间戳，便于回溯
# ---------------------------------------------------------------
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
RELEASE="${GIT_SHA}-$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="${REMOTE_ROOT}/releases/${RELEASE}"
say "版本 ${RELEASE}"

# ---------------------------------------------------------------
# 3. 上传
# ---------------------------------------------------------------
say "上传到 ${SSH_HOST}:${RELEASE_DIR}"
ssh "$SSH_HOST" "mkdir -p '${RELEASE_DIR}'"
rsync -az --delete --chmod=D755,F644 dist/ "${SSH_HOST}:${RELEASE_DIR}/"

# ---------------------------------------------------------------
# 4. 原子切换 + 清理旧版本
# ---------------------------------------------------------------
say "切换 current 软链"
ssh "$SSH_HOST" "
  set -e
  ln -sfn '${RELEASE_DIR}' '${REMOTE_ROOT}/current.new'
  mv -Tf '${REMOTE_ROOT}/current.new' '${REMOTE_ROOT}/current'
  cd '${REMOTE_ROOT}/releases'
  ls -1dt */ | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf
  echo \"current -> \$(readlink -f '${REMOTE_ROOT}/current')\"
"

# ---------------------------------------------------------------
# 5. 冒烟测试
# ---------------------------------------------------------------
say "冒烟测试 ${PUBLIC_URL}"
code="$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_URL")"
[ "$code" = "200" ] || die "首页返回 ${code}"

asset="$(grep -o "${BASE_PATH}assets/[^\"]*\.js" dist/index.html | head -1)"
acode="$(curl -s -o /dev/null -w '%{http_code}' "https://qlili.com${asset}")"
[ "$acode" = "200" ] || die "资源 ${asset} 返回 ${acode}"

printf '\033[32m✓\033[0m 部署完成 → %s\n' "$PUBLIC_URL"
