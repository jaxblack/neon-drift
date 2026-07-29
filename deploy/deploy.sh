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
# 注意：不带斜杠。Git Bash (MSYS) 会把以 / 开头的环境变量当成 POSIX 路径，
# 自动展开成 C:/Program Files/Git/speed，构建出来的资源路径线上必然 404。
BASE_NAME="${BASE_NAME:-speed}"
BASE_PATH="/${BASE_NAME}/"
SITE="${SITE:-https://qlili.com}"
PUBLIC_URL="${SITE}${BASE_PATH}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

cd "$(dirname "$0")/.."

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------
# 1. 构建
# ---------------------------------------------------------------
say "构建（base=${BASE_PATH}）"
[ -d node_modules ] || npm ci
VITE_BASE_PATH="$BASE_NAME" npm run build

[ -f dist/index.html ] || die "dist/index.html 不存在，构建失败了"

# 从产物里把入口 JS 的真实路径抽出来做精确比对。
# 不能用 grep -q "/speed/assets/" —— 被 MSYS 污染成
# "/Program Files/Git/speed/assets/" 时它依然包含该子串，断言会被绕过。
LOCAL_ASSET="$(sed -n 's/.*<script[^>]*src="\([^"]*\.js\)".*/\1/p' dist/index.html | head -1)"
[ -n "$LOCAL_ASSET" ] || die "dist/index.html 里找不到入口 script"
[ "$LOCAL_ASSET" != "${LOCAL_ASSET#"${BASE_PATH}assets/"}" ] \
  || die "构建产物的资源路径是 '${LOCAL_ASSET}'，不是预期的 ${BASE_PATH}assets/... （base 没生效）"

# ---------------------------------------------------------------
# 2. 版本号：git 短 hash + 时间戳，便于回溯
# ---------------------------------------------------------------
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
RELEASE="${GIT_SHA}-$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="${REMOTE_ROOT}/releases/${RELEASE}"
say "版本 ${RELEASE}"

# ---------------------------------------------------------------
# 3. 上传（用 tar 而不是 rsync —— Windows 的 Git Bash 没有 rsync，
#    而 tar 在 mac / Linux / Git Bash / 服务器上都自带）
# ---------------------------------------------------------------
say "打包上传到 ${SSH_HOST}:${RELEASE_DIR}"
TARBALL="$(mktemp -t neon-drift-XXXXXX).tgz"
trap 'rm -f "$TARBALL"' EXIT
tar -czf "$TARBALL" -C dist .

REMOTE_TAR="/tmp/neon-drift-${RELEASE}.tgz"
scp -q "$TARBALL" "${SSH_HOST}:${REMOTE_TAR}"
ssh "$SSH_HOST" "
  set -e
  mkdir -p '${RELEASE_DIR}'
  tar -xzf '${REMOTE_TAR}' -C '${RELEASE_DIR}'
  rm -f '${REMOTE_TAR}'
  chmod -R a+rX '${RELEASE_DIR}'
"

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
# 5. 冒烟测试：端到端拉线上的 HTML，从里面取资源路径再请求一次。
# 只检查本地产物是不够的，路由/缓存/软链切换都可能出错。
# ---------------------------------------------------------------
say "冒烟测试 ${PUBLIC_URL}"
HTML="$(curl -fsS "$PUBLIC_URL")" || die "首页拉不到"

LIVE_ASSET="$(printf '%s' "$HTML" | sed -n 's/.*<script[^>]*src="\([^"]*\.js\)".*/\1/p' | head -1)"
[ -n "$LIVE_ASSET" ] || die "线上 HTML 里找不到入口 script"
[ "$LIVE_ASSET" != "${LIVE_ASSET#"${BASE_PATH}assets/"}" ] \
  || die "线上资源路径是 '${LIVE_ASSET}'，不是预期的 ${BASE_PATH}assets/..."

curl -fsS -o /dev/null "${SITE}${LIVE_ASSET}" || die "资源 ${LIVE_ASSET} 拉不到"
# 入口 HTML 不能被长缓存，否则下次发布用户拿到的还是旧的 assets 引用
curl -fsS -o /dev/null -D - "$PUBLIC_URL" 2>/dev/null | grep -qi 'cache-control: *no-cache' \
  || printf '\033[33m!\033[0m %s\n' "提醒：入口 HTML 没有 no-cache 头"

printf '\033[32m\u2713\033[0m 部署完成 → %s  (asset: %s)\n' "$PUBLIC_URL" "$LIVE_ASSET"
