#!/usr/bin/env bash
# リリース用スクリプト（scripts/release/）のテスト。
# GitHub API は tests/release/bin/gh（モック）で再現し、実際のリポジトリには接続しない。
# 各検証は文字列で渡して eval するため、単一引用符内の変数展開は意図どおり（SC2016）。
# shellcheck disable=SC2016,SC2034
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
scripts="$root/scripts/release"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export PATH="$here/bin:$PATH"
export GITHUB_REPOSITORY="owner/editor"
export GITHUB_RUN_ID=777

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "  ok - $1"; }
ng() { failed=$((failed + 1)); echo "  NG - $1"; }
check() { if eval "$2"; then ok "$1"; else ng "$1"; fi; }
q() { jq -r "$1" "$MOCK_GH_STATE"; }

SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OTHER=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
printf 'zip-v1' >"$work/editor-v0.2.0.zip"
printf '### 追加\n\n- 新機能\n' >"$work/notes.md"
TITLE='Web Text Editor v0.2.0'
publish() { "$scripts/publish.sh" v0.2.0 "$work/editor-v0.2.0.zip" "$work/notes.md" "$TITLE" "$1" >"$work/out.log" 2>&1; }
new_state() { export MOCK_GH_STATE="$work/state-$1.json"; printf '%s' "${2:-{\}}" >"$MOCK_GH_STATE"; }

echo "# changelog-section.sh"
cat >"$work/CHANGELOG.md" <<'MD'
# 変更履歴

## v0.3.0（2026-12-01）

- 次の版

## v0.2.0

### 追加

- 画面分割

## v0.2

- 紛らわしい見出し

## v0.1.0

MD
out="$("$scripts/changelog-section.sh" v0.2.0 "$work/CHANGELOG.md")"
check "対応する節だけを取り出す" '[[ "$out" == $'"'"'### 追加\n\n- 画面分割'"'"' ]]'
out="$("$scripts/changelog-section.sh" v0.3.0 "$work/CHANGELOG.md")"
check "見出しの後ろの日付を許容する" '[[ "$out" == "- 次の版" ]]'
check "節がなければエラー" '! "$scripts/changelog-section.sh" v0.9.0 "$work/CHANGELOG.md" >/dev/null 2>&1'
check "本文が空の節はエラー" '! "$scripts/changelog-section.sh" v0.1.0 "$work/CHANGELOG.md" >/dev/null 2>&1'
check "CHANGELOG.md がなければエラー" '! "$scripts/changelog-section.sh" v0.2.0 "$work/none.md" >/dev/null 2>&1'

echo "# package.sh"
mkdir -p "$work/dist/assets"
printf '<script type="module" src="./assets/a.js"></script>' >"$work/dist/index.html"
printf 'x' >"$work/dist/assets/a.js"
check "dist の中身を ZIP の直下に入れる" '"$scripts/package.sh" v0.2.0 "$work/dist" "$work/pkg.zip" >/dev/null && [[ "$(unzip -Z1 "$work/pkg.zip" | sort | tr "\n" " ")" == "assets/a.js index.html " ]]'
printf '<script src="/assets/a.js"></script>' >"$work/dist/index.html"
check "ルート基準の参照があればエラー" '! "$scripts/package.sh" v0.2.0 "$work/dist" "$work/pkg.zip" >/dev/null 2>&1'
printf '<script src="./assets/a.js"></script>' >"$work/dist/index.html"
printf '{}' >"$work/dist/package.json"
check "配布不要なファイルがあればエラー" '! "$scripts/package.sh" v0.2.0 "$work/dist" "$work/pkg.zip" >/dev/null 2>&1'
rm "$work/dist/package.json" "$work/dist/index.html"
check "index.html がなければエラー" '! "$scripts/package.sh" v0.2.0 "$work/dist" "$work/pkg.zip" >/dev/null 2>&1'

echo "# publish.sh: 初回（タグ・Release なし）"
new_state fresh
check "成功する" 'publish "$SHA"'
check "タグをビルドしたコミットに作成する" '[[ "$(q ".tags[\"v0.2.0\"]")" == "$SHA" ]]'
check "Release を公開する（下書きではない）" '[[ "$(q ".releases | length")" == 1 && "$(q ".releases[0].draft")" == false ]]'
check "タイトル・本文を設定する" '[[ "$(q ".releases[0].name")" == "$TITLE" && "$(q ".releases[0].body")" == "$(cat "$work/notes.md")" ]]'
check "ZIP を正式な名前で 1 つだけ添付する" '[[ "$(q "[.releases[0].assets[].name] | join(\",\")")" == "editor-v0.2.0.zip" ]]'
check "下書きで作成してから公開する" 'q ".calls | join(\"\\n\")" | grep -q "^POST releases$" && [[ "$(q "[.calls[] | select(startswith(\"PATCH releases/\") and (contains(\"assets\") | not))] | length")" == 1 ]]'

echo "# publish.sh: 同じバージョンの再実行（同じコミット）"
first_asset="$(q '.releases[0].assets[0].id')"
printf 'zip-v2' >"$work/editor-v0.2.0.zip"
printf '### 追加\n\n- 新機能（更新）\n' >"$work/notes.md"
check "成功する" 'publish "$SHA"'
check "タグは変わらない" '[[ "$(q ".tags[\"v0.2.0\"]")" == "$SHA" && "$(q "[.calls[] | select(. == \"POST git/refs\")] | length")" == 1 ]]'
check "Release を作り直さない" '[[ "$(q ".releases | length")" == 1 ]]'
check "ZIP を差し替える（1 つだけ・新しい内容）" '[[ "$(q ".releases[0].assets | length")" == 1 && "$(q ".releases[0].assets[0].id")" != "$first_asset" && "$(q ".releases[0].assets[0].sha256")" == "$(printf zip-v2 | sha256sum | cut -d" " -f1)" ]]'
check "本文を更新する" '[[ "$(q ".releases[0].body")" == *"更新"* ]]'
check "新しい ZIP をアップロードしてから旧 ZIP を削除する" 'q ".calls | join(\"\\n\")" | awk "/^POST releases\/[0-9]+\/assets/{u=NR} /^DELETE releases\/assets/{d=NR} END{exit !(u && d && u < d)}"'

echo "# publish.sh: 既存タグが別のコミットを指している"
new_state moved "{\"tags\":{\"v0.2.0\":\"$OTHER\"}}"
check "エラーになる" '! publish "$SHA"'
check "エラーの理由を示す" 'grep -q "一致しません" "$work/out.log"'
check "タグを動かさず、Release も作らない" '[[ "$(q ".tags[\"v0.2.0\"]")" == "$OTHER" && "$(q ".releases | length")" == 0 ]]'

echo "# publish.sh: 注釈付きタグ"
new_state annotated "{\"annotated\":{\"v0.2.0\":{\"tagObject\":\"tagobj\",\"commit\":\"$SHA\"}}}"
check "タグの指すコミットが一致すれば成功する" 'publish "$SHA"'

echo "# publish.sh: 既存 Release の更新中に ZIP のアップロードが失敗"
new_state upfail "{\"tags\":{\"v0.2.0\":\"$SHA\"},\"releases\":[{\"id\":1,\"tag_name\":\"v0.2.0\",\"name\":\"旧タイトル\",\"body\":\"旧本文\",\"draft\":false,\"assets\":[{\"id\":2,\"name\":\"editor-v0.2.0.zip\",\"sha256\":\"old\"}]}]}"
check "エラーになる" '! MOCK_FAIL=upload publish "$SHA"'
check "既存の ZIP・タイトル・本文は変わらない" '[[ "$(q ".releases[0].assets | map(.name + \":\" + .sha256) | join(\",\")")" == "editor-v0.2.0.zip:old" && "$(q ".releases[0].name")" == "旧タイトル" && "$(q ".releases[0].body")" == "旧本文" ]]'

echo "# publish.sh: 既存 Release の更新中に名前の変更が失敗"
new_state renfail "{\"tags\":{\"v0.2.0\":\"$SHA\"},\"releases\":[{\"id\":1,\"tag_name\":\"v0.2.0\",\"name\":\"旧タイトル\",\"body\":\"旧本文\",\"draft\":false,\"assets\":[{\"id\":2,\"name\":\"editor-v0.2.0.zip\",\"sha256\":\"old\"}]}]}"
check "エラーになる" '! MOCK_FAIL=rename publish "$SHA"'
check "ZIP は一時的な名前で残り、取得できる状態を保つ" '[[ "$(q ".releases[0].assets | length")" == 1 && "$(q ".releases[0].assets[0].name")" == editor-v0.2.0.uploading-777-* ]]'
sleep 1
check "同じ実行の再試行（同じ GITHUB_RUN_ID）で正式な名前に戻る" 'publish "$SHA" && [[ "$(q "[.releases[0].assets[].name] | join(\",\")")" == "editor-v0.2.0.zip" ]]'

echo "# publish.sh: 以前の失敗で下書きの Release と一時ファイルが残っている"
new_state draft "{\"tags\":{\"v0.2.0\":\"$SHA\"},\"releases\":[{\"id\":1,\"tag_name\":\"v0.2.0\",\"name\":\"$TITLE\",\"body\":\"x\",\"draft\":true,\"assets\":[{\"id\":2,\"name\":\"editor-v0.2.0.uploading-123.zip\",\"sha256\":\"half\"}]}]}"
check "成功する" 'publish "$SHA"'
check "下書きを再利用して公開する" '[[ "$(q ".releases | length")" == 1 && "$(q ".releases[0].draft")" == false ]]'
check "残っていた一時ファイルを削除する" '[[ "$(q "[.releases[0].assets[].name] | join(\",\")")" == "editor-v0.2.0.zip" ]]'

echo "# publish.sh: 新規作成時の公開前に失敗"
new_state draftfail
check "エラーになる" '! MOCK_FAIL=edit publish "$SHA"'
check "公開されていない（下書きのまま）" '[[ "$(q ".releases[0].draft")" == true ]]'

echo "# publish.sh: 入力の検証"
new_state input
check "不正なバージョンを拒否する" '! "$scripts/publish.sh" 0.2.0 "$work/editor-v0.2.0.zip" "$work/notes.md" "$TITLE" "$SHA" >/dev/null 2>&1'
check "空のリリースノートを拒否する" ': >"$work/empty.md"; ! "$scripts/publish.sh" v0.2.0 "$work/editor-v0.2.0.zip" "$work/empty.md" "$TITLE" "$SHA" >/dev/null 2>&1'
check "API を呼ばない" '[[ "$(q ".calls | length")" == 0 ]]'

echo
echo "passed: ${passed}, failed: ${failed}"
[[ "$failed" == 0 ]]
