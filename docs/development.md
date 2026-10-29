# 開発者ガイド

[README](../README.md) に戻る · [配備・リリース](deployment.md)

## 開発と検証

Node.js 20.19 以上（22 推奨）が必要です。

```bash
npm ci              # 依存パッケージのインストール
npm run dev         # 開発サーバー（http://localhost:5173/）
npm run typecheck   # 型チェック
npm test            # 単体テスト（Vitest + jsdom）
npm run build       # 型チェック + 本番ビルド（dist/ に出力）
npm run preview     # ビルド結果の確認
npm run test:release # リリース用スクリプトのテスト
npm run test:e2e    # E2E テスト（Playwright。事前に npm run build が必要）
```

PR の CI（[ci.yml](../.github/workflows/ci.yml)）は型チェック・単体・ビルド・リリース用スクリプト・配布 ZIP の静的配信・全 E2E を検証します。

E2E テストを初めて実行する場合は `npx playwright install chromium` でブラウザを取得してください。
E2E テストはビルド結果を `/editor/` 配下で配信し、GitHub Pages のサブパス配備を再現して実行します。

## ディレクトリ構成

```
src/
  core/      タブモデル・画面分割モデル・差分計算・検索・改行コード・文字コード・バックアップ・Markdown 変換（DOM 非依存）
  editor/    CodeMirror の構成、タブごとの EditorState 管理、言語の遅延読み込み、テーマ
  storage/   保存処理（StorageBackend インターフェース、localStorage 実装、自動保存制御、スキーマ）
  files/     ファイルの読み込み・書き出し
  ui/        メニュー・タブバー・編集ペイン・ステータスバー・検索パネル・ダイアログ等の UI 部品
  app/       各部品をつなぐアプリ本体、コマンド、メニュー定義、ショートカット
tests/
  unit/      単体テスト
  e2e/       E2E テスト
```

保存処理は `StorageBackend` インターフェース（[src/storage/backend.ts](../src/storage/backend.ts)）で抽象化しており、IndexedDB 等の実装へ差し替えられます。
保存データにはスキーマバージョンを持たせており、形式を変更する場合は [src/storage/schema.ts](../src/storage/schema.ts) の `SCHEMA_VERSION` と `migrate` を更新します（v0.2.0 でスキーマ v2 に更新し、v1 のデータは読み込み時に自動で移行します）。

差分比較は、差分の計算と統一差分形式への整形（[src/core/diff.ts](../src/core/diff.ts)）、比較元・比較先の強調表示を各タブの EditorState に持たせる拡張（[src/editor/diffMarks.ts](../src/editor/diffMarks.ts)）、結果表示の読み取り専用ビューの拡張（[src/editor/diffResult.ts](../src/editor/diffResult.ts)）、比較の進行とペイン配置の復元（[src/app/diffController.ts](../src/app/diffController.ts)）に分かれています。結果表示は `EditorManager` の一時的なビュー（タブではない読み取り専用の EditorState）として表示し、ペインのタブの本文・Undo 履歴は退避して、終了後にそのまま復元します。

画面分割は、どのペインにどのタブを表示するかを `PaneLayout`（[src/core/paneLayout.ts](../src/core/paneLayout.ts)）が、ペインごとの CodeMirror の表示を `EditorManager`（[src/editor/editorManager.ts](../src/editor/editorManager.ts)）が担当します。タブの一覧・順序は従来どおり `TabStore` が管理します。

保存データのキーは `webTextEditor:` で始まります。保存スキーマとバックアップ形式は別に管理し、変更時は既存データの読み込み・移行も検証してください。バックアップの利用上の互換性は [利用ガイド](user-guide.md#保存上の注意) を参照してください。

## 利用ライブラリ

- [CodeMirror 6](https://codemirror.net/)（MIT）。差分の計算に `@codemirror/merge` を利用しています
- [marked](https://marked.js.org/)（MIT）
- [DOMPurify](https://github.com/cure53/DOMPurify)（Apache-2.0 / MPL-2.0）
- [fflate](https://github.com/101arrowz/fflate)（MIT）。一括書き出しの ZIP 生成に利用し、配布ファイルに同梱しています（[ライセンス全文](../public/fflate-LICENSE.txt)）
