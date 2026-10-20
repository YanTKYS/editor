#!/usr/bin/env bash
# CHANGELOG.md から指定バージョンの節（「## v0.2.0」の次行から次の「## 」の手前まで）を出力する。
# 節が見つからない、または本文が空の場合はエラー終了する。
#
# 使い方: changelog-section.sh <version> [CHANGELOG.md のパス]
set -euo pipefail

version="${1:?バージョンを指定してください（例: v0.2.0）}"
file="${2:-CHANGELOG.md}"

if [[ ! -f "$file" ]]; then
  echo "::error::${file} が見つかりません" >&2
  exit 1
fi

# 見出しは「## v0.2.0」または「## v0.2.0（日付など）」を対象とする
section="$(awk -v ver="$version" '
  /^## / {
    if (found) exit
    heading = $2
    sub(/[（(].*$/, "", heading)
    if (heading == ver) { found = 1; next }
  }
  found { print }
' "$file")"

# 前後の空行を除く
section="$(printf '%s\n' "$section" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')"

if [[ -z "${section//[[:space:]]/}" ]]; then
  echo "::error::${file} に ${version} の変更履歴が見つかりません（「## ${version}」の節が必要です）" >&2
  exit 1
fi

printf '%s\n' "$section"
