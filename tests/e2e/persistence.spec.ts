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
  await expect(page.locator('.status-save')).toHaveText('自動保存済み', { timeout: 6000 });
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
  await expect(page.locator('.status-save')).toHaveText('自動保存済み');
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
  await expect(page.locator('.status-save')).toHaveText('自動保存済み');
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

/** localStorage への書き込みを失敗させる（容量超過の再現） */
async function failStorageWrites(page: import('@playwright/test').Page, keyPattern = '') {
  await page.evaluate((pattern) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (!pattern || key.includes(pattern)) throw new DOMException('full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  }, keyPattern);
}

test('ページを閉じる直前の保存に失敗したら、閉じる前に警告する', async ({ page }) => {
  await openApp(page);
  await failStorageWrites(page);
  // 自動保存（デバウンス）より前に閉じる
  await typeInEditor(page, '保存できない編集');
  const dialog = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const d = await dialog;
  expect(d.type()).toBe('beforeunload');
  await d.dismiss(); // 閉じるのを取り消す
  expect(page.isClosed()).toBe(false);
  await expect(page.locator('.status-save')).toHaveText('保存失敗');
  expect(await editorText(page)).toBe('保存できない編集');
});

test('保存に成功していれば、閉じるときに警告しない', async ({ page }) => {
  await openApp(page);
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs++;
    void d.accept();
  });
  await typeInEditor(page, '保存できる編集');
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => page.isClosed()).toBe(true);
  expect(dialogs).toBe(0);
});

test('タブを閉じて編集した後の保存が失敗しても、再読み込みで直前の保存内容が復元される', async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, 'タブAの保存済み本文');
  await page.keyboard.press('Alt+n');
  await page.keyboard.type('タブBの保存済み本文');
  await saveNow(page);
  const tabB = await page.evaluate(
    () => (JSON.parse(localStorage.getItem('webTextEditor:meta') ?? '{}') as { tabs: { id: string }[] }).tabs[1].id,
  );

  // タブ B の本文書き込みだけ失敗させ、A を閉じて B を編集する
  await failStorageWrites(page, `tab:${tabB}`);
  await page.locator('.tab').first().locator('.tab-close').click();
  await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('（未保存の追記）');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.status-save')).toHaveText('保存失敗');

  page.on('dialog', (d) => void d.accept()); // 終了時の警告を承諾して再読み込み
  await page.reload();
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  await expect(page.locator('.tab .tab-label')).toHaveText(['新規 1', '新規 2']);
  expect(await editorText(page)).toBe('タブBの保存済み本文');
  await page.keyboard.press('Alt+PageUp');
  expect(await editorText(page)).toBe('タブAの保存済み本文');
});
