import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { activeTab, editorText, openApp, tabs, typeInEditor } from './helpers';

async function openFiles(page: Page, files: { name: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles(files.map((f) => ({ ...f, mimeType: 'text/plain' })));
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('ファイルを読み込み、改行コード（CRLF）を維持して書き出す', async ({ page }) => {
  await openFiles(page, [{ name: 'memo.txt', buffer: Buffer.from('一行目\r\n二行目\r\n', 'utf-8') }]);
  await expect(activeTab(page)).toHaveText('memo.txt');
  await expect(tabs(page)).toHaveCount(1); // 空の新規タブは置き換える
  await expect(page.locator('.status-eol')).toHaveText('CRLF');
  expect(await editorText(page)).toBe('一行目\n二行目\n');

  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('三行目');
  await expect(page.locator('.tab.active')).toHaveClass(/modified/);

  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+Shift+s');
  const file = await download;
  expect(file.suggestedFilename()).toBe('memo.txt');
  const bytes = await readFile(await file.path());
  expect(bytes.toString('utf-8')).toBe('一行目\r\n二行目\r\n三行目');
  await expect(page.locator('.tab.active')).not.toHaveClass(/modified/);
});

test('複数ファイルを一括で開き、拡張子から編集モードを判定する', async ({ page }) => {
  await openFiles(page, [
    { name: 'a.json', buffer: Buffer.from('{"a": 1}') },
    { name: 'b.md', buffer: Buffer.from('# B') },
    { name: 'c.ts', buffer: Buffer.from('const x: number = 1;') },
  ]);
  await expect(page.locator('.tab .tab-label')).toHaveText(['a.json', 'b.md', 'c.ts']);
  await expect(page.locator('.status-mode')).toHaveText('TypeScript');
  await page.locator('.tab', { hasText: 'a.json' }).click();
  await expect(page.locator('.status-mode')).toHaveText('JSON');
});

test('Shift_JIS のファイルは確認のうえ Shift_JIS として読み込める', async ({ page }) => {
  // 「日本語」(Shift_JIS)
  const sjis = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
  await openFiles(page, [{ name: 'sjis.txt', buffer: sjis }]);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('UTF-8 として正しく読み込めない');
  await dialog.getByRole('button', { name: 'Shift_JIS として開く' }).click();
  await expect(activeTab(page)).toHaveText('sjis.txt');
  expect(await editorText(page)).toBe('日本語');
  await expect(page.locator('.status-enc')).toHaveText('Shift_JIS → UTF-8');
});

test('メニューから Shift_JIS を指定して開く', async ({ page }) => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'ファイル' }).click();
  await page.getByRole('menuitem', { name: 'Shift_JIS のファイルを開く…' }).click();
  await (await chooser).setFiles([{ name: 's.txt', mimeType: 'text/plain', buffer: Buffer.from([0x82, 0xa0, 0x82, 0xa2]) }]);
  await expect(activeTab(page)).toHaveText('s.txt');
  expect(await editorText(page)).toBe('あい');
});

test('バイナリファイルは開かない', async ({ page }) => {
  await openFiles(page, [{ name: 'x.bin', buffer: Buffer.from([0, 1, 2, 3]) }]);
  await expect(page.locator('.toast-error')).toContainText('バイナリファイル');
  await expect(activeTab(page)).toHaveText('新規 1');
});

test('ドラッグ＆ドロップでファイルを開く', async ({ page }) => {
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['dropped text'], 'dropped.txt', { type: 'text/plain' }));
    document.querySelector('.cm-content')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(activeTab(page)).toHaveText('dropped.txt');
  expect(await editorText(page)).toBe('dropped text');
});

test('バックアップの書き出しと復元（置き換え）', async ({ page }) => {
  await typeInEditor(page, 'バックアップ対象');
  await page.keyboard.press('Alt+n');
  await page.keyboard.type('二つ目');

  await page.getByRole('menuitem', { name: 'ファイル' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /バックアップを書き出し/ }).click();
  const file = await download;
  const json = await readFile(await file.path(), 'utf-8');
  const data = JSON.parse(json) as { format: string; tabs: { content: string }[] };
  expect(data.format).toBe('web-text-editor-backup');
  expect(data.tabs.map((t) => t.content)).toEqual(['バックアップ対象', '二つ目']);

  // 内容を変えてから復元
  await page.keyboard.press('Alt+n');
  await page.keyboard.type('消える予定');
  await page.getByRole('menuitem', { name: 'ファイル' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'バックアップから復元…' }).click();
  await (await chooser).setFiles([{ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(json) }]);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('タブ数: 2');
  await dialog.getByRole('button', { name: '置き換える' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '上書きする' }).click();
  await expect(page.locator('.tab .tab-label')).toHaveText(['新規 1', '新規 2']);
  expect(await editorText(page)).toBe('二つ目');
});

test('不正なバックアップは復元前に拒否する', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'ファイル' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'バックアップから復元…' }).click();
  await (await chooser).setFiles([{ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"foo":1}') }]);
  await expect(page.getByRole('dialog')).toContainText('バックアップファイルではありません');
});
