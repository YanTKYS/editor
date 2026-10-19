import { expect, test } from '@playwright/test';
import { activeTab, editorText, openApp, saveNow, tabs, typeInEditor } from './helpers';

test('再読み込み後にタブ構成・本文・アクティブタブ・設定を復元する', async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, '一つ目\n日本語のテキスト');
  await page.keyboard.press('Alt+n');
  await page.keyboard.type('二つ目');
  await page.keyboard.press('Alt+n');
  await page.keyboard.type('三つ目');
  await page.keyboard.press('Alt+PageUp'); // 2 つ目をアクティブに
  await page.keyboard.press('Alt+z'); // 折り返し ON
  await saveNow(page);

  await page.reload();
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  await expect(tabs(page)).toHaveCount(3);
  await expect(activeTab(page)).toHaveText('新規 2');
  expect(await editorText(page)).toBe('二つ目');
  await expect(page.locator('.cm-lineWrapping')).toHaveCount(1);
  await page.keyboard.press('Alt+PageUp');
  expect(await editorText(page)).toBe('一つ目\n日本語のテキスト');
});

test('自動保存（デバウンス）で保存される', async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, '自動保存のテスト');
  await expect(page.locator('.status-save')).toHaveText('ブラウザ保存済', { timeout: 6000 });
  await page.reload();
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  expect(await editorText(page)).toBe('自動保存のテスト');
});

test('ページを閉じる直前の変更も保存される', async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, 'すぐに再読み込み');
  // デバウンス待ちの間に再読み込み（pagehide で保存される）
  await page.reload();
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  expect(await editorText(page)).toBe('すぐに再読み込み');
});

test('別のブラウザタブで更新された場合は競合として検知し、上書きしない', async ({ page, context }) => {
  await openApp(page);
  await typeInEditor(page, 'A');
  await saveNow(page);

  const other = await context.newPage();
  await other.goto('./');
  await expect(other.locator('html[data-ready="true"]')).toBeAttached();
  await expect(other.locator('.banner[data-banner="multi"]')).toBeVisible();
  await typeInEditor(other, 'B');
  await saveNow(other);

  // 最初のタブ: 他タブの保存を検知
  await expect(page.locator('.banner[data-banner="storage"]')).toContainText('別のブラウザタブ');
  await typeInEditor(page, 'C');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.status-save')).toHaveText('保存停止（競合）');
  const stored = await page.evaluate(() => {
    const meta = JSON.parse(localStorage.getItem('webTextEditor:meta') ?? '{}') as { tabs: { id: string }[] };
    return localStorage.getItem(`webTextEditor:tab:${meta.tabs[0].id}`);
  });
  expect(stored).toBe('AB');

  // このタブの内容で上書き
  await page.getByRole('button', { name: 'このタブの内容で上書き保存' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '上書き保存' }).click();
  await expect(page.locator('.status-save')).toHaveText('ブラウザ保存済');
  await expect(other.locator('.banner[data-banner="storage"]')).toBeVisible();
  await other.close();
});

test('容量超過で保存に失敗しても編集内容を保持し、利用者に知らせる', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as unknown as { __restoreSetItem: () => void }).__restoreSetItem = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function () {
      throw new DOMException('full', 'QuotaExceededError');
    };
  });
  await typeInEditor(page, '保存できない内容');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.banner[data-banner="storage"]')).toContainText('保存容量の不足');
  await expect(page.locator('.status-save')).toHaveText('保存失敗');
  expect(await editorText(page)).toBe('保存できない内容');

  // 容量が空いたら再試行で保存できる
  await page.evaluate(() => (window as unknown as { __restoreSetItem: () => void }).__restoreSetItem());
  await page.getByRole('button', { name: '再試行' }).click();
  await expect(page.locator('.status-save')).toHaveText('ブラウザ保存済');
  await expect(page.locator('.banner[data-banner="storage"]')).toHaveCount(0);
});

test('壊れた保存データは上書きせずに知らせる', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => localStorage.setItem('webTextEditor:meta', '{broken'));
  await page.reload();
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  await expect(page.locator('.banner[data-banner="storage"]')).toContainText('自動保存を停止');
  await typeInEditor(page, 'x');
  await page.keyboard.press('Control+s');
  expect(await page.evaluate(() => localStorage.getItem('webTextEditor:meta'))).toBe('{broken');
});

test('再読み込み後にカーソル位置とスクロール位置を復元する', async ({ page }) => {
  await openApp(page);
  await page.evaluate((text) => {
    const app = (window as unknown as { __editorApp: { editor: { view: { dispatch(s: unknown): void } } } }).__editorApp;
    app.editor.view.dispatch({ changes: { from: 0, insert: text } });
  }, Array.from({ length: 300 }, (_, i) => `行 ${i + 1}`).join('\n'));
  await page.keyboard.press('Control+g');
  await page.getByRole('dialog').getByRole('textbox').fill('250:3');
  await page.keyboard.press('Enter');
  await expect(page.locator('.status-pos')).toHaveText('行 250, 列 3');
  await page.reload();
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  await expect(page.locator('.status-pos')).toHaveText('行 250, 列 3');
  await expect(page.locator('.cm-line', { hasText: /^行 250$/ })).toBeInViewport();
});
