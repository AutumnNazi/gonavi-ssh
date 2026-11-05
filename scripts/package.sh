#!/usr/bin/env bash
# 组装可安装的插件包：三平台后端二进制 + 前端产物 + 清单 → package/ 目录，
# 再压缩为 dist/<plugin-id>-<version>.zip（GoNavi 支持目录 / ZIP / TGZ 安装）。
# 注意：清单声明了三个平台条目，宿主要求包内全部条目文件都存在。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_ID="$(node -p "require(process.argv[1]).id" "$ROOT/gonavi.plugin.json")"
MANIFEST_VERSION="$(node -p "require(process.argv[1]).version" "$ROOT/gonavi.plugin.json")"
VERSION="${1-$MANIFEST_VERSION}"
if [ "$VERSION" != "$MANIFEST_VERSION" ]; then
  echo "错误：显式版本 $VERSION 与清单版本 $MANIFEST_VERSION 不一致" >&2
  exit 1
fi
STAGE="$ROOT/package"
OUT="$ROOT/dist/$MANIFEST_ID-$VERSION.zip"

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
# 宿主把入口文档直接放在 `/` 上返回（不再 302 到 /plugin-assets/frontend/index.html），
# 文档里的相对路径会解析到 /assets/...，被宿主按前缀挡掉 404：窗口白屏，控制台也没有任何提示。
# 所以入口引用的资源必须是 /plugin-assets/frontend/ 下的绝对路径，且文件真实存在于构建产物里。
ENTRY_HTML="$ROOT/frontend/dist/index.html"
if [ ! -f "$ENTRY_HTML" ]; then
  echo "错误：前端构建产物缺少入口文档 $ENTRY_HTML" >&2
  exit 1
fi
ENTRY_REFS="$(grep -oE '(src|href)="[^"]+"' "$ENTRY_HTML" | sed -E 's/^[^"]*"//; s/"$//' || true)"
for ref in $ENTRY_REFS; do
  case "$ref" in
    /plugin-assets/frontend/*) ;;
    *)
      echo "错误：入口文档引用了非绝对资源 $ref；宿主在 / 上返回该文档，资源必须是 /plugin-assets/frontend/ 下的绝对路径，否则 404 导致白屏" >&2
      exit 1
      ;;
  esac
  if [ ! -f "$ROOT/frontend/dist/${ref#/plugin-assets/frontend/}" ]; then
    echo "错误：入口文档引用的资源在构建产物中不存在：$ref" >&2
    exit 1
  fi
done
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
