import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import type { TabMeta } from '../../src/core/types';
import { openApp } from './helpers';

interface AppHandle {
  store: { all: TabMeta[]; update(id: string, patch: Partial<TabMeta>): void; rename(id: string, name: string): void };
  editor: { getContent(id: string): string; applyToTab(id: string, build: () => { changes: { from: number; insert: string } }): void };
  addTab(init: Partial<TabMeta>, content: string): { id: string };
  activateTab(id: string, focus?: boolean): void;
}
const inspect = (page: Page) => page.evaluate(() => {
  const app = (window as unknown as { __editorApp: AppHandle }).__editorApp;
  return app.store.all.map(t => ({ id: t.id, name: t.name, modified: t.modifiedSinceFile, encoding: t.encoding, eol: t.eol, bom: t.bom, content: app.editor.getContent(t.id) }));
});
async function seed(page: Page) {
  await openApp(page);
  await page.evaluate(() => {
    const a = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    const first = a.addTab({ name: '同名.txt', modifiedSinceFile: true, encoding: 'Shift_JIS', eol: 'CRLF', bom: true }, '日本語\n次');
    a.addTab({ name: '同名.txt', modifiedSinceFile: true, eol: 'CR' }, '二\n行');
    a.addTab({ name: '保存済み.txt', modifiedSinceFile: false }, '保存済み');
    a.addTab({ name: '除外.txt', modifiedSinceFile: true }, '残す');
    a.activateTab(first.id, true);
  });
}
async function openExport(page: Page) {
  await page.getByRole('menuitem', { name: 'ファイル', exact: true }).click();
  await page.getByRole('menuitem', { name: '未書き出しタブをまとめて書き出し…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '未書き出しタブをまとめて書き出し', exact: true })).toBeVisible();
}
async function downloadZip(page: Page) {
  const event = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'ZIP をダウンロード', exact: true }).click();
  const file = await event;
  expect(file.suggestedFilename()).toMatch(/^editor-files-.*\.zip$/);
  const entries = unzipSync(await readFile(await file.path()));
  await expect(page.getByRole('dialog', { name: 'ZIP の保存確認', exact: true })).toBeVisible();
  return entries;
}

test('選択した通常ファイルをZIPで取得し、保存確認後だけ状態を更新して本文・履歴を維持する', async ({ page }) => {
  const external: string[] = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol.startsWith('http') && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      external.push(url.href); return route.abort();
    }
    return route.continue();
  });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await seed(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('!');
  const before = await inspect(page);
  await openExport(page);
  const d = page.getByRole('dialog');
  await expect(d).toContainText('バックアップ JSON とは別');
  await expect(d.getByRole('checkbox')).toHaveCount(3);
  await expect(d).toContainText('ZIP 内：同名 (2).txt');
  await d.getByRole('checkbox', { name: /^タブ 5 — 除外.txt/ }).uncheck();
  const files = await downloadZip(page);
  expect(Object.keys(files)).toEqual(['同名.txt', '同名 (2).txt']);
  expect([...files['同名.txt'].slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(Buffer.from(files['同名.txt']).toString('utf8')).toBe('\ufeff日本語\r\n次!');
  expect(Buffer.from(files['同名 (2).txt']).toString('utf8')).toBe('二\r行');
  expect(await inspect(page)).toEqual(before); // ダウンロード開始では解除しない
  await page.getByRole('dialog').getByRole('button', { name: '保存を確認した', exact: true }).click();
  const after = await inspect(page);
  expect(after.map(t => t.content)).toEqual(before.map(t => t.content));
  expect(after.map(t => t.name)).toEqual(before.map(t => t.name));
  expect(after.map(t => t.modified)).toEqual([false, false, false, false, true]);
  expect(after[1].encoding).toBe('UTF-8');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  expect((await inspect(page))[1].content).toBe('日本語\n次');
  await page.keyboard.press('Control+y');
  expect((await inspect(page))[1].content).toBe('日本語\n次!');
  expect(external).toEqual([]);
  expect(errors).toEqual([]); // 本番CSPでもWorkerやCDNを必要としない
});

test('キャンセル・対象なしではダウンロードせず未書き出し状態を維持する', async ({ page }) => {
  await seed(page);
  const before = await inspect(page);
  let downloads = 0;
  page.on('download', () => downloads++);
  await openExport(page);
  const d = page.getByRole('dialog');
  await d.getByRole('button', { name: '全タブを解除', exact: true }).click();
  await expect(d.getByRole('button', { name: 'ZIP をダウンロード', exact: true })).toBeDisabled();
  await d.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(d).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await inspect(page)).toEqual(before);
  expect(downloads).toBe(0);
});

test('ZIP保存を中止・保留した場合は未書き出し表示を解除しない', async ({ page }) => {
  await seed(page);
  const before = await inspect(page);
  await openExport(page);
  await downloadZip(page);
  await page.getByRole('dialog').getByRole('button', { name: '未書き出しのまま閉じる', exact: true }).click();
  expect(await inspect(page)).toEqual(before);
});

for (const change of ['本文', '名前', '改行'] as const) {
  test(`ZIP生成後の${change}変更は保存確認後も未書き出しのまま残す`, async ({ page }) => {
    await seed(page);
    await openExport(page);
    await downloadZip(page);
    await page.evaluate(change => {
      const a = (window as unknown as { __editorApp: AppHandle }).__editorApp;
      const id = a.store.all[1].id;
      if (change === '本文') a.editor.applyToTab(id, () => ({ changes: { from: 0, insert: '追記 ' } }));
      else if (change === '名前') a.store.rename(id, '変更後.txt');
      else a.store.update(id, { eol: 'LF' });
    }, change);
    const changed = await inspect(page);
    await page.getByRole('dialog').getByRole('button', { name: '保存を確認した', exact: true }).click();
    const actual = await inspect(page);
    expect(actual.map(t => t.content)).toEqual(changed.map(t => t.content));
    expect(actual[1].modified).toBe(true);
    expect(actual[2].modified).toBe(false);
    expect(actual[4].modified).toBe(false);
    await expect(page.locator('.toast').last()).toContainText('変更された 1 タブ');
  });
}

for (const failure of ['生成', 'URL作成', 'ダウンロード開始'] as const) {
  test(`${failure}の失敗で未書き出し表示や本文を変更しない`, async ({ page }) => {
    await seed(page);
    const before = await inspect(page);
    await openExport(page);
    await page.evaluate(failure => {
      if (failure === '生成') TextEncoder.prototype.encode = () => { throw new Error('生成失敗テスト'); };
      else if (failure === 'URL作成') URL.createObjectURL = () => { throw new Error('URL失敗テスト'); };
      else HTMLAnchorElement.prototype.click = () => { throw new Error('開始失敗テスト'); };
    }, failure);
    await page.getByRole('dialog').getByRole('button', { name: 'ZIP をダウンロード', exact: true }).click();
    await expect(page.locator('.toast-error').last()).toContainText('未書き出し状態は変更していません');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await inspect(page)).toEqual(before);
    await expect(page.locator('a[download]')).toHaveCount(0);
  });
}

test('多数の同名タブをページ間で選択し、選択外は維持する', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const a = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    for (let i = 0; i < 25; i++) a.addTab({ name: '同名.txt', modifiedSinceFile: true }, `body-${i}\n`);
  });
  await openExport(page);
  const d = page.getByRole('dialog');
  await expect(d.getByRole('checkbox')).toHaveCount(20);
  await d.getByRole('button', { name: '全タブを解除', exact: true }).click();
  await d.getByRole('checkbox').first().focus();
  await page.keyboard.press('Space');
  await d.getByRole('button', { name: '次のページ', exact: true }).click();
  await expect(d.getByRole('checkbox')).toHaveCount(5);
  await d.getByRole('checkbox').last().check();
  await d.getByRole('button', { name: '前のページ', exact: true }).click();
  await expect(d.getByRole('checkbox').first()).toBeChecked();
  await expect(d.getByRole('checkbox').nth(1)).not.toBeChecked();
  const files = await downloadZip(page);
  expect(Object.keys(files).sort()).toEqual(['同名 (25).txt', '同名.txt']);
  expect(Buffer.from(files['同名.txt']).toString()).toBe('body-0\n');
  expect(Buffer.from(files['同名 (25).txt']).toString()).toBe('body-24\n');
  await page.getByRole('dialog').getByRole('button', { name: '保存を確認した', exact: true }).click();
  expect((await inspect(page)).filter(t => t.modified)).toHaveLength(23);
});

test('選択中の名前変更は実行前に検知して一覧の作り直しを案内する', async ({ page }) => {
  await seed(page);
  await openExport(page);
  await page.evaluate(() => {
    const a = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    a.store.rename(a.store.all[1].id, '変更後.txt');
  });
  const before = await inspect(page);
  await page.getByRole('dialog').getByRole('button', { name: 'ZIP をダウンロード', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('一覧を開き直してください');
  await page.keyboard.press('Escape');
  expect(await inspect(page)).toEqual(before);
});
