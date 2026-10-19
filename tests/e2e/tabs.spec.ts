import { expect, test } from '@playwright/test';
import { activeTab, editor, editorText, openApp, tabs, typeInEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('複数タブを作成・編集し、切り替えても Undo 履歴が維持される', async ({ page }) => {
  await typeInEditor(page, 'タブ1の本文');
  await page.keyboard.press('Alt+n');
  await expect(tabs(page)).toHaveCount(2);
  await expect(activeTab(page)).toHaveText('新規 2');
  await page.keyboard.type('second');
  await page.keyboard.press('Enter');
  await page.keyboard.type('line2');

  // 前のタブへ（Alt+PageUp）
  await page.keyboard.press('Alt+PageUp');
  await expect(activeTab(page)).toHaveText('新規 1');
  expect(await editorText(page)).toBe('タブ1の本文');
  await page.keyboard.press('Control+z');
  expect(await editorText(page)).toBe('');
  await page.keyboard.press('Control+y');
  expect(await editorText(page)).toBe('タブ1の本文');

  // 次のタブへ（Alt+PageDown）: こちらの履歴も残っている
  await page.keyboard.press('Alt+PageDown');
  await expect(activeTab(page)).toHaveText('新規 2');
  expect(await editorText(page)).toBe('second\nline2');
  await page.keyboard.press('Control+z');
  expect(await editorText(page)).not.toBe('second\nline2');
});

test('タブ名の変更で編集モードが切り替わる', async ({ page }) => {
  await page.keyboard.press('F2');
  const input = page.getByRole('dialog').getByRole('textbox');
  await input.fill('議事録.md');
  await page.keyboard.press('Enter');
  await expect(activeTab(page)).toHaveText('議事録.md');
  await expect(page.locator('.status-mode')).toHaveText('Markdown');
  await expect(page).toHaveTitle(/議事録\.md/);
});

test('ダブルクリックで名前変更、空の名前は拒否される', async ({ page }) => {
  await page.locator('.tab').first().dblclick();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('   ');
  await dialog.getByRole('button', { name: '変更' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('名前を入力してください。');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(activeTab(page)).toHaveText('新規 1');
});

test('内容のあるタブを閉じるときは確認し、閉じたタブを開き直せる', async ({ page }) => {
  await typeInEditor(page, '大事なメモ');
  await page.keyboard.press('Alt+n');
  await page.locator('.tab').first().locator('.tab-close').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('ファイルに書き出されていません');
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await expect(tabs(page)).toHaveCount(2);

  await page.locator('.tab').first().locator('.tab-close').click();
  await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(tabs(page)).toHaveCount(1);

  await page.keyboard.press('Alt+Shift+t');
  await expect(tabs(page)).toHaveCount(2);
  await expect(activeTab(page)).toHaveText('新規 1');
  expect(await editorText(page)).toBe('大事なメモ');
});

test('空のタブは確認なしで閉じ、最後のタブを閉じると新規タブが残る', async ({ page }) => {
  await page.keyboard.press('Alt+w');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
});

test('ドラッグ＆ドロップでタブを並べ替えられる', async ({ page }) => {
  await page.keyboard.press('Alt+n');
  await page.keyboard.press('Alt+n');
  await expect(tabs(page)).toHaveCount(3);
  const labels = page.locator('.tab .tab-label');
  await expect(labels).toHaveText(['新規 1', '新規 2', '新規 3']);
  await tabs(page).nth(2).dragTo(tabs(page).nth(0), { targetPosition: { x: 5, y: 5 } });
  await expect(labels).toHaveText(['新規 3', '新規 1', '新規 2']);
});

test('キーボードでタブバーを操作できる', async ({ page }) => {
  await page.keyboard.press('Alt+n');
  await page.locator('.tab.active').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(activeTab(page)).toHaveText('新規 1');
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect(page.locator('.tab .tab-label')).toHaveText(['新規 2', '新規 1']);
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeFocused();
});

test('多数のタブは横スクロールでき、アクティブタブが表示される', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 500 });
  for (let i = 0; i < 14; i++) await page.keyboard.press('Alt+n');
  const list = page.locator('.tab-list');
  const scroll = await list.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sl: el.scrollLeft }));
  expect(scroll.sw).toBeGreaterThan(scroll.cw);
  expect(scroll.sl).toBeGreaterThan(0);
  await expect(page.locator('.tab.active')).toBeInViewport();
  // ページ全体は横にはみ出さない
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
