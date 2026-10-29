# 配備・リリース

[README](../README.md) に戻る · [開発者ガイド](development.md)

## ビルドと配備先

GitHub Actions ではアプリのテスト・ビルドに Node.js 22 を使用します。CI・Release のアーティファクト転送と Pages のアクションは Node.js 24 対応版を使用します。アクション自身の実行ランタイムと、`actions/setup-node` で選択するアプリの Node.js バージョンは別の設定です。

`npm run build` で `dist/` に静的ファイル一式が出力されます。アセットは相対パスで参照するため、任意のサブパスに配置できます。

## GitHub Pages

`main` ブランチへの push（PR のマージ）で [deploy.yml](../.github/workflows/deploy.yml) が実行され、テスト・ビルド後に GitHub Pages へ配備されます。
初回のみ、リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定してください。
公開 URL は `https://<ユーザー名>.github.io/<リポジトリ名>/` です。

開発コマンドと CI の確認は [開発者ガイド](development.md) を参照してください。

## 配布 ZIP をローカルで確認する

Releases の ZIP を展開して `index.html` をダブルクリック（`file://`）で開くと、ブラウザの CORS 制限により JavaScript・CSS を読み込めず、画面が表示されません。
Windows では、リポジトリの [scripts/serve-editor.ps1](../scripts/serve-editor.ps1) で簡易 HTTP サーバーを起動して確認できます（Windows PowerShell 5.1 で動作し、Node.js・Python・IIS は不要です）。

1. [Releases](https://github.com/YanTKYS/editor/releases) から `editor-vX.Y.Z.zip` をダウンロードし、任意のフォルダー（例: `C:\work\editor`）に展開する（直下に `index.html` と `assets/` が並びます）
2. `scripts/serve-editor.ps1` をダウンロードするかリポジトリを取得し、PowerShell で展開先のフォルダーを指定して実行する

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\serve-editor.ps1 -Folder C:\work\editor
   ```

   `-Port 9000` のようにポート番号を変更できます（既定は 8765）。`-Folder` を省略すると、現在のフォルダーを配信します。
3. ブラウザで <http://localhost:8765/> を開く
4. 確認が終わったら、PowerShell で `Ctrl+C` を押して終了する

サーバーは `127.0.0.1` のみで待ち受けるため、同じネットワークの他の PC からはアクセスできません。確認用の簡易サーバーであり、配布用 ZIP には同梱しません。

## IIS 等の静的 Web サーバー

`dist/` の中身、または Releases の `editor-vX.Y.Z.zip` を展開した中身（直下に `index.html` と `assets/`）を、任意のディレクトリ（例: `C:\inetpub\wwwroot\editor\`）にコピーするだけで動作します。サーバー側の設定やリライトは不要です。

## リリースの準備と公開

収録内容は [変更履歴](../CHANGELOG.md)、対応状況は [提案一覧](feature-ideas.md) で管理します。過去の [v0.5.0 公開記録](release-v0.5.0.md) は同版の公開確認に使用してください。

1. 次版のバージョンを package.json と package-lock.json のトップレベル・packages[""].version に揃え、CHANGELOG.md に同版の節を用意します。
2. Node.js 22 で [開発者ガイドの検証](development.md#開発と検証) と、次のローカル配布確認を実行します。`vX.Y.Z` は公開する版に置き換えてください。

   ```bash
   npm run check
   npm run test:release
   ./scripts/release/changelog-section.sh vX.Y.Z CHANGELOG.md > /tmp/editor-release-notes.md
   ./scripts/release/package.sh vX.Y.Z dist /tmp/editor-vX.Y.Z.zip
   ./scripts/release/smoke-test.sh /tmp/editor-vX.Y.Z.zip
   ```

3. 全 E2E を含む PR の CI 成功を確認し、main にマージします。上記のとおり main へのマージは Pages 自動配備も起動します。
4. **Actions → Release → Run workflow** でブランチ `main` と入力 `version`（例: `v0.5.0`）を指定します。実行者にはワークフローの手動実行権限が必要です。
5. build・publish の成功後、タグ、公開された Release、`editor-vX.Y.Z.zip` とリリースノートを確認します。ZIP を静的サーバーで起動して版表示と主要操作を確認し、ドキュメントの公開状況を更新します。

Release の build は型チェック・単体・本番ビルドと ZIP の静的配信を検証します。Release 自身には E2E 実行がないため、PR の CI 成功も確認してください。実装は [release.yml](../.github/workflows/release.yml) と [scripts/release/](../scripts/release/) です。標準の GITHUB_TOKEN を使い、build は contents: read、publish は contents: write で動作します。

| 成果物 | 内容 |
| --- | --- |
| タグ `vX.Y.Z` | 初回は実行時点の main のコミットに作成。既存タグがあればそのコミットをビルドし、タグは移動しない |
| Release `Web Text Editor vX.Y.Z` | 検証成功後、下書きから公開。本文は変更履歴の該当節 |
| `editor-vX.Y.Z.zip` | index.html・assets/・favicon.svg・fflate-LICENSE.txt。ソースや node_modules は含めない |
| Actions artifact `release-files` | ZIP と release-notes.md。保持期間7日 |
| build のジョブサマリー | 対象 SHA、ZIP 名・サイズ・SHA-256 |

同じ版で再実行すると既存タグのコミットからビルドし、Release の ZIP・タイトル・本文を差し替えます。新しい ZIP を一時名でアップロードし、旧 ZIP を退避してから正式名に切り替えます。失敗時は旧 ZIP を正式名へ戻し、復旧できない場合も `editor-vX.Y.Z.previous-….zip` として残して通知します。再実行で差し替えを完了できます。
