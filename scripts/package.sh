#!/usr/bin/env bash
# 组装可安装的插件包：三平台后端二进制 + 前端产物 + 清单 → package/ 目录，
# 再压缩为 dist/gonavi-ssh-v<version>.zip（GoNavi 支持目录 / ZIP / TGZ 安装）。
# 注意：清单声明了三个平台条目，宿主要求包内全部条目文件都存在。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-0.0.1}"
STAGE="$ROOT/package"
OUT="$ROOT/dist/gonavi-ssh-v$VERSION.zip"

cd "$ROOT"

rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/frontend" "$ROOT/dist"

build_backend() {
  local goos="$1" goarch="$2" out="$3"
  echo "==> go build $goos/$goarch"
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
    go build -trimpath -ldflags "-s -w" -o "$STAGE/bin/$out" ./cmd/plugin
}

build_backend windows amd64 gonavi-ssh-windows-amd64.exe
build_backend linux   amd64 gonavi-ssh-linux-amd64
build_backend darwin  arm64 gonavi-ssh-darwin-arm64

echo "==> frontend build"
(cd "$ROOT/frontend" && node node_modules/typescript/bin/tsc --noEmit && node node_modules/vite/bin/vite.js build)
cp -r "$ROOT/frontend/dist/." "$STAGE/frontend/"

cp "$ROOT/gonavi.plugin.json" "$STAGE/"

echo "==> zip"
rm -f "$OUT"
if [ -x /c/Windows/System32/tar.exe ]; then
  # Windows 自带 bsdtar：-a 按 .zip 扩展名自动选 zip 格式
  (cd "$STAGE" && /c/Windows/System32/tar.exe -a -cf "$OUT" bin frontend gonavi.plugin.json)
elif command -v zip >/dev/null; then
  (cd "$STAGE" && zip -r -q "$OUT" bin frontend gonavi.plugin.json)
else
  echo "错误：找不到可用的 zip 工具" >&2
  exit 1
fi

echo "完成：$OUT"
echo "安装（GoNavi CLI）："
echo "  gonavi plugin --root <dev-root> inspect $OUT"
echo "  gonavi plugin --root <dev-root> install --digest <digest> --trust $OUT"
