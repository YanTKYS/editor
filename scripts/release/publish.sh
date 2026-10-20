#!/usr/bin/env bash
# タグと GitHub Release を作成・更新し、配布用 ZIP を添付する（gh CLI と jq を使用）。
#
# - タグがなければ、ビルドしたコミットに作成する。既存のタグは移動・再作成しない
#   （既存タグがビルドしたコミットと異なる場合はエラー）
# - Release がなければ下書きとして作成し、ZIP を添付してから公開する
# - Release があれば、ZIP を次の順序で差し替え、最後にタイトル・本文を更新する
#   1. 新しい ZIP を一時名でアップロード（失敗しても旧 ZIP は変更しない）
#   2. 旧 ZIP を退避名に変更
#   3. 新しい ZIP を正式名に変更（失敗したら旧 ZIP を正式名に戻す）
#   4. 新しい ZIP が正式名になってから、退避した旧 ZIP と以前の残留ファイルを削除
#   Release Assets は複数の操作をまとめて行えないため、どの段階で失敗しても
#   旧 ZIP は削除せず、正式名または退避名で取得できる状態で残す
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
# 一時名・退避名（同じワークフロー実行の再試行でも重複しないよう、試行番号と時刻を含める）
run_tag="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$(date +%s)"
temp_prefix="${asset_name%.zip}.uploading-"
backup_prefix="${asset_name%.zip}.previous-"
temp_name="${temp_prefix}${run_tag}.zip"
backup_name="${backup_prefix}${run_tag}.zip"

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

list_assets() {
  gh api --paginate "repos/${repo}/releases/${release_id}/assets?per_page=100" | jq -s 'add // []'
}
rename_asset() {
  gh api -X PATCH "repos/${repo}/releases/assets/${1}" -f name="$2" >/dev/null
}
delete_asset() {
  gh api -X DELETE "repos/${repo}/releases/assets/${1}" >/dev/null
}

# 1. 新しい ZIP を一時名でアップロードする（失敗しても既存の ZIP には触れない）
upload_url="https://uploads.github.com/repos/${repo}/releases/${release_id}/assets?name=${temp_name}"
new_asset_id="$(gh api -X POST "$upload_url" -H 'Content-Type: application/zip' --input "$zip_path" | jq -r '.id')" ||
  fail "ZIP のアップロードに失敗しました（既存の ZIP は変更していません）"
[[ -n "$new_asset_id" && "$new_asset_id" != null ]] || fail "ZIP のアップロードに失敗しました（既存の ZIP は変更していません）"

old_asset_id="$(list_assets | jq -r --arg name "$asset_name" '.[] | select(.name == $name) | .id')"

if [[ -n "$old_asset_id" ]]; then
  # 2. 旧 ZIP を退避名にする（正式名を空けるため。失敗したら旧 ZIP はそのまま）
  if ! rename_asset "$old_asset_id" "$backup_name"; then
    delete_asset "$new_asset_id" || true
    fail "既存の ZIP の退避に失敗しました（既存の ZIP は変更していません）"
  fi
  # 3. 新しい ZIP を正式名にする。失敗したら旧 ZIP を正式名に戻す
  if ! rename_asset "$new_asset_id" "$asset_name"; then
    if rename_asset "$old_asset_id" "$asset_name"; then
      delete_asset "$new_asset_id" || true
      fail "新しい ZIP の名前の変更に失敗したため、既存の ZIP を元に戻しました（Release は更新していません）"
    fi
    fail "新しい ZIP の名前の変更と、既存の ZIP の復旧に失敗しました。既存の ZIP は ${backup_name} として残っています（削除していません）。再実行すると差し替えを完了します"
  fi
else
  # 正式名の ZIP がない（初回、または以前の失敗で退避名のまま残っている）
  rename_asset "$new_asset_id" "$asset_name" ||
    fail "新しい ZIP の名前の変更に失敗しました（既存のファイルは削除していません）"
fi

# 4. 新しい ZIP が正式名になったので、退避した旧 ZIP と以前の失敗で残った一時・退避ファイルを削除する
stale_ids="$(list_assets | jq -r --arg tmp "$temp_prefix" --arg bak "$backup_prefix" --argjson keep "$new_asset_id" \
  '.[] | select(.id != $keep and ((.name | startswith($tmp)) or (.name | startswith($bak)))) | .id')"
for id in $stale_ids; do
  delete_asset "$id" || echo "::warning::不要になったファイル（id: ${id}）を削除できませんでした。次回の実行で削除します"
done

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
