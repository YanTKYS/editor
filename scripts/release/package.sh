#!/usr/bin/env bash
# ビルド結果（dist/）の中身を配布用 ZIP にまとめ、構成を検証する。
# ZIP を展開すると直下に index.html・assets/ などが並ぶ（dist/ ディレクトリ自体は含めない）。
#
# 使い方: package.sh <version> <dist ディレクトリ> <出力 ZIP のパス>
set -euo pipefail

version="${1:?バージョンを指定してください}"
dist="${2:?dist ディレクトリを指定してください}"
out="${3:?出力先を指定してください}"

fail() {
  echo "::error::$*" >&2
  exit 1
}

[[ -f "$dist/index.html" ]] || fail "$dist/index.html がありません（ビルドに失敗しています）"
[[ -d "$dist/assets" ]] || fail "$dist/assets がありません"

# 静的サーバーの任意のパスに置けるよう、アセットは相対パスで参照していること
if grep -Eq '(src|href)="/[^/]' "$dist/index.html"; then
  fail "index.html にルート基準（/ 始まり）の参照があります。任意のパスに配置できません"
fi

out_abs="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
rm -f "$out_abs"
# -X: OS 固有の属性を含めない / -D: ディレクトリ項目を含めない
(cd "$dist" && zip -q -r -X -D "$out_abs" .)

listing="$(unzip -Z1 "$out_abs")"
grep -qx 'index.html' <<<"$listing" || fail "ZIP の直下に index.html がありません"
grep -q '^assets/' <<<"$listing" || fail "ZIP に assets/ がありません"
if grep -Eq '(^|/)(node_modules|src|tests|\.git|dist)/|(^|/)package(-lock)?\.json$|\.ts$|\.map$' <<<"$listing"; then
  fail "ZIP に配布不要なファイルが含まれています:$(grep -E '(^|/)(node_modules|src|tests|\.git|dist)/|(^|/)package(-lock)?\.json$|\.ts$|\.map$' <<<"$listing" | head -5 | sed 's/^/ /')"
fi

echo "作成: $(basename "$out_abs")（${version}、$(wc -l <<<"$listing") ファイル、$(du -h "$out_abs" | cut -f1)）"
while IFS= read -r line; do echo "  ${line}"; done <<<"$listing"
