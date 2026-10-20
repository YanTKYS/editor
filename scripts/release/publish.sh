#!/usr/bin/env bash
# タグと GitHub Release を作成・更新し、配布用 ZIP を添付する（gh CLI と jq を使用）。
#
# - タグがなければ、ビルドしたコミットに作成する。既存のタグは移動・再作成しない
#   （既存タグがビルドしたコミットと異なる場合はエラー）
# - Release がなければ下書きとして作成し、ZIP を添付してから公開する
# - Release があれば、ZIP を一時的な名前でアップロードしてから旧 ZIP と差し替え、
#   最後にタイトル・本文を更新する（途中で失敗しても既存の ZIP は残る）
#
# 使い方: publish.sh <version> <ZIP のパス> <リリースノートのパス> <タイトル> <コミット SHA>
# 環境変数: GITHUB_REPOSITORY（owner/repo）、GH_TOKEN、GITHUB_RUN_ID・GITHUB_RUN_ATTEMPT（任意）
set -euo pipefail

version="${1:?バージョンを指定してください}"
zip_path="${2:?ZIP を指定してください}"
notes_path="${3:?リリースノートを指定してください}"
title="${4:?タイトルを指定してください}"
sha="${5:?コミット SHA を指定してください}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY が未設定です}"
asset_name="$(basename "$zip_path")"
# 一時的な名前（同じワークフロー実行の再試行でも重複しないよう、試行番号と時刻を含める）
temp_name="${asset_name%.zip}.uploading-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$(date +%s).zip"

fail() {
  echo "::error::$*" >&2
  exit 1
}

[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "バージョンの形式が不正です: ${version}"
[[ -f "$zip_path" ]] || fail "${zip_path} がありません"
[[ -s "$notes_path" ]] || fail "リリースノートが空です"

# ---------- タグ ----------
# 既存タグの指すコミット（注釈付きタグの場合はタグオブジェクトをたどる）。なければ空
tag_commit() {
  local ref
  ref="$(gh api "repos/${repo}/git/ref/tags/${version}" 2>/dev/null)" || return 0
  local type obj
  type="$(jq -r '.object.type' <<<"$ref")"
  obj="$(jq -r '.object.sha' <<<"$ref")"
  if [[ "$type" == "tag" ]]; then
    obj="$(gh api "repos/${repo}/git/tags/${obj}" | jq -r '.object.sha')"
  fi
  printf '%s' "$obj"
}

existing="$(tag_commit)"
if [[ -z "$existing" ]]; then
  echo "タグ ${version} を ${sha} に作成します"
  gh api -X POST "repos/${repo}/git/refs" -f ref="refs/tags/${version}" -f sha="$sha" >/dev/null
elif [[ "$existing" != "$sha" ]]; then
  fail "タグ ${version} は ${existing} を指しており、ビルドしたコミット ${sha} と一致しません（タグは変更しません）"
else
  echo "タグ ${version} は既に ${sha} を指しています"
fi

# ---------- Release ----------
# 下書きを含めて、このタグの Release を探す
release_id="$(gh api --paginate "repos/${repo}/releases?per_page=100" | jq -rs --arg tag "$version" \
  '[.[][] | select(.tag_name == $tag)] | first | .id // empty')"

created=false
if [[ -z "$release_id" ]]; then
  echo "Release ${version} を下書きとして作成します"
  release_id="$(gh api -X POST "repos/${repo}/releases" \
    -f tag_name="$version" -f name="$title" -F body=@"$notes_path" -F draft=true | jq -r '.id')"
  created=true
else
  echo "既存の Release ${version}（id: ${release_id}）を更新します"
fi

# 一時的な名前でアップロードする（失敗しても既存の ZIP はそのまま）
upload_url="https://uploads.github.com/repos/${repo}/releases/${release_id}/assets?name=${temp_name}"
new_asset_id="$(gh api -X POST "$upload_url" -H 'Content-Type: application/zip' --input "$zip_path" | jq -r '.id')"
[[ -n "$new_asset_id" && "$new_asset_id" != null ]] || fail "ZIP のアップロードに失敗しました"

# 旧 ZIP（同名）と、以前の失敗で残った一時ファイルを削除してから、新しい ZIP を正式な名前にする
assets="$(gh api --paginate "repos/${repo}/releases/${release_id}/assets?per_page=100" | jq -s 'add // []')"
stale_ids="$(jq -r --arg name "$asset_name" --arg base "${asset_name%.zip}.uploading-" --argjson keep "$new_asset_id" \
  '.[] | select(.id != $keep and (.name == $name or (.name | startswith($base)))) | .id' <<<"$assets")"
for id in $stale_ids; do
  gh api -X DELETE "repos/${repo}/releases/assets/${id}" >/dev/null
done
gh api -X PATCH "repos/${repo}/releases/assets/${new_asset_id}" -f name="$asset_name" >/dev/null

# タイトル・本文を更新し、下書きなら公開する。
# 古いバージョンを再実行しても「最新」が入れ替わらないよう、最新の判定は日付とバージョン番号に任せる
gh api -X PATCH "repos/${repo}/releases/${release_id}" \
  -f name="$title" -F body=@"$notes_path" -F draft=false -f make_latest=legacy >/dev/null

url="$(gh api "repos/${repo}/releases/${release_id}" | jq -r '.html_url')"
if [[ "$created" == true ]]; then
  echo "Release を公開しました: ${url}"
else
  echo "Release を更新しました: ${url}"
fi
