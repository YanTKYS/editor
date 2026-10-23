import { expect, test } from '@playwright/test';
import { activeTab, editorText, openApp, typeInEditor } from './helpers';

const panel = (page: import('@playwright/test').Page) => page.locator('.find-panel');
const count = (page: import('@playwright/test').Page) => page.locator('.find-count');
const searchInput = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: '検索する文字列' });
const replaceInput = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: '置換後の文字列' });

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('タブ内検索: 件数表示と次・前への移動', async ({ page }) => {
  await typeInEditor(page, 'apple Apple\nbanana apple');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+f');
  await expect(searchInput(page)).toBeFocused();
  await page.keyboard.type('apple');
  await expect(count(page)).toHaveText('1 / 3 件');
  await page.keyboard.press('Enter');
  await expect(count(page)).toHaveText('2 / 3 件');
  await page.keyboard.press('Enter');
  await expect(count(page)).toHaveText('3 / 3 件');
  await page.keyboard.press('Shift+Enter');
  await expect(count(page)).toHaveText('2 / 3 件');
  await expect(page.locator('.cm-searchMatch')).toHaveCount(3);

  // 大文字小文字を区別
  await page.getByRole('button', { name: '大文字と小文字を区別' }).click();
  await expect(count(page)).toHaveText(/2 件/);
  // 見つからない場合
  await searchInput(page).fill('zzz');
  await expect(count(page)).toHaveText('0 件');
  // Esc で閉じてエディタへ戻る
  await page.keyboard.press('Escape');
  await expect(page.locator('.find-panel')).toBeHidden();
  await expect(page.locator('.cm-content')).toBeFocused();
  await expect(page.locator('.cm-searchMatch')).toHaveCount(0);
});

test('正規表現検索と不正な正規表現の表示', async ({ page }) => {
  await typeInEditor(page, 'id=1\nid=22\nname=x');
  await page.keyboard.press('Control+f');
  await page.getByRole('button', { name: '正規表現' }).click();
  await searchInput(page).fill('id=\\d+');
  await expect(count(page)).toHaveText(/2 件/);
  await searchInput(page).fill('id=(');
  await expect(count(page)).toHaveText('正規表現が不正です');
});

test('置換と一括置換（Undo 可能）', async ({ page }) => {
  await typeInEditor(page, 'foo foo foo');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+h');
  await searchInput(page).fill('foo');
  await replaceInput(page).fill('bar');
  await panel(page).getByRole('button', { name: '置換', exact: true }).click();
  expect(await editorText(page)).toBe('bar foo foo');
  await page.getByRole('button', { name: 'このタブをすべて置換', exact: true }).click();
  expect(await editorText(page)).toBe('bar bar bar');
  await expect(page.locator('.toast').last()).toContainText('2 件を置換しました');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  expect(await editorText(page)).toBe('bar foo foo');
});

test('正規表現の置換で参照を使える', async ({ page }) => {
  await typeInEditor(page, '2024-05-01\n2025-12-31');
  await page.keyboard.press('Control+h');
  await page.getByRole('button', { name: '正規表現' }).click();
  await searchInput(page).fill('(\\d+)-(\\d+)-(\\d+)');
  await replaceInput(page).fill('$1年$2月$3日');
  await page.getByRole('button', { name: 'このタブをすべて置換', exact: true }).click();
  expect(await editorText(page)).toBe('2024年05月01日\n2025年12月31日');
});

test('全タブ横断検索と結果からの移動、全タブ置換', async ({ page }) => {
  await typeInEditor(page, '一行目\n東京都の資料');
  await page.keyboard.press('Alt+n');
  await page.keyboard.type('大阪\n\n東京');
  await page.keyboard.press('Alt+n');
  await page.keyboard.type('関係なし');

  await page.keyboard.press('Control+Shift+f');
  await searchInput(page).fill('東京');
  await page.getByRole('button', { name: '全タブ検索' }).click();
  const results = page.locator('.results-panel');
  await expect(results).toBeVisible();
  await expect(results.locator('.results-title')).toHaveText('全タブの検索結果「東京」: 2 件（2 タブ）');
  await expect(results.locator('.result-item')).toHaveCount(2);

  await results.locator('.result-item').first().click();
  await expect(activeTab(page)).toHaveText('新規 1');
  const sel = await page.evaluate(() => {
    const app = (window as unknown as { __editorApp: { editor: { view: { state: { selection: { main: { from: number; to: number } }; sliceDoc(a: number, b: number): string } } } } }).__editorApp;
    const s = app.editor.view.state;
    return s.sliceDoc(s.selection.main.from, s.selection.main.to);
  });
  expect(sel).toBe('東京');

  await page.keyboard.press('Control+h');
  await replaceInput(page).fill('TOKYO');
  await page.getByRole('button', { name: '全タブをすべて置換' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '置換する' }).click();
  expect(await editorText(page)).toBe('一行目\nTOKYO都の資料');
  await page.keyboard.press('Alt+PageDown');
  expect(await editorText(page)).toBe('大阪\n\nTOKYO');
  // 非アクティブだったタブでも Undo できる
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  expect(await editorText(page)).toBe('大阪\n\n東京');
});

test('選択中の文字列を検索語にし、F3 で次を検索する', async ({ page }) => {
  await typeInEditor(page, 'abc xyz abc');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+End');
  for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Control+f');
  await expect(searchInput(page)).toHaveValue('abc');
  await page.keyboard.press('Escape');
  await page.keyboard.press('F3');
  const head = await page.evaluate(
    () => (window as unknown as { __editorApp: { editor: { view: { state: { selection: { main: { head: number } } } } } } }).__editorApp.editor.view.state.selection.main.head,
  );
  expect(head).toBe(11);
});

test('指定行へ移動', async ({ page }) => {
  await typeInEditor(page, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
  await page.keyboard.press('Control+g');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('999');
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('1〜50');
  await dialog.getByRole('textbox').fill('25');
  await page.keyboard.press('Enter');
  await expect(page.locator('.status-pos')).toHaveText('行 25, 列 1');
});
