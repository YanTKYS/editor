#!/usr/bin/env bash
# 配布用 ZIP を展開し、汎用の静的 Web サーバー（python3 -m http.server）の
# サブディレクトリに配置した状態で、index.html と参照するアセットがすべて取得できることを確認する。
# （GitHub Pages 以外の静的サーバー・任意のパスへの配置を想定した確認）
#
# 使い方: smoke-test.sh <ZIP のパス>
set -euo pipefail

zip_path="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
work="$(mktemp -d)"
port="${SMOKE_PORT:-8765}"
subdir="apps/text-editor"
trap 'kill "$server_pid" 2>/dev/null || true; rm -rf "$work"' EXIT

mkdir -p "$work/root/$subdir"
unzip -q "$zip_path" -d "$work/root/$subdir"

python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/root" >/dev/null 2>&1 &
server_pid=$!
base="http://127.0.0.1:${port}/${subdir}/"
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "$base" 2>/dev/null && break
  sleep 0.1
done

html="$(curl -fsS "$base")" || { echo "::error::${base} を取得できません" >&2; exit 1; }
grep -q '<div id="app"' <<<"$html" || { echo "::error::index.html の内容が想定と異なります" >&2; exit 1; }

# index.html が参照するスクリプト・スタイル・アイコンを取得できること
refs="$(grep -oE '(src|href)="[^"]+"' <<<"$html" | sed -E 's/^(src|href)="(.*)"$/\2/' | grep -vE '^(https?:|data:|#)')"
[[ -n "$refs" ]] || { echo "::error::index.html にアセットの参照がありません" >&2; exit 1; }
count=0
while IFS= read -r ref; do
  url="${base}${ref#./}"
  code="$(curl -s -o /dev/null -w '%{http_code}' "$url")"
  if [[ "$code" != 200 ]]; then
    echo "::error::${ref} を取得できません（HTTP ${code}）" >&2
    exit 1
  fi
  count=$((count + 1))
done <<<"$refs"

# 遅延読み込みされるチャンク（言語サポート等）も ZIP 内の相対パスで取得できること
for chunk in $(unzip -Z1 "$zip_path" | grep -E '^assets/.*\.js$'); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "${base}${chunk}")"
  [[ "$code" == 200 ]] || { echo "::error::${chunk} を取得できません（HTTP ${code}）" >&2; exit 1; }
  count=$((count + 1))
done

echo "静的サーバーのサブパス /${subdir}/ で ${count} 件のファイルを取得できました"
