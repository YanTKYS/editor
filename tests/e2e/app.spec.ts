import { expect, test } from '@playwright/test';
import { openApp, typeInEditor } from './helpers';

test('サブパス配下でエラーなく起動し、CSP が設定されている', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  const failed: string[] = [];
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  await openApp(page);
  expect(page.url()).toContain('/editor/');
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /script-src 'self'/);
  // 言語サポート（遅延読み込みチャンク）も読み込めること
  await page.keyboard.press('F2');
  await page.getByRole('dialog').getByRole('textbox').fill('x.json');
  await page.keyboard.press('Enter');
  await typeInEditor(page, '{"a": [1, 2]}');
  await expect(page.locator('.cm-content span').first()).toBeVisible();
  expect(errors).toEqual([]);
  expect(failed).toEqual([]);
});

test('ステータスバーに行・列・文字数・選択文字数を表示する', async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, 'あいう\n𠮷野家');
  await expect(page.locator('.status-pos')).toHaveText('行 2, 列 4');
  await expect(page.locator('.status-counts')).toHaveText('6 文字 / 2 行');
  await page.keyboard.press('Control+a');
  await expect(page.locator('.status-sel')).toHaveText('選択: 6 文字 (2 行)');
  await expect(page.locator('.status-eol')).toHaveText('LF');
  await expect(page.locator('.status-enc')).toHaveText('UTF-8');
});

test('テーマ・文字サイズ・表示設定を切り替えて保存する', async ({ page }) => {
  await openApp(page);
  await page.getByRole('menuitem', { name: '表示' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'ダークテーマ' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('menuitem', { name: '表示' }).click();
  await page.getByRole('menuitem', { name: '文字を大きく' }).click();
  await page.getByRole('menuitem', { name: '表示' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'スペース・タブを表示' }).click();
  await page.getByRole('menuitem', { name: '表示' }).click();
  await page.getByRole('menuitemcheckbox', { name: '改行コードを表示' }).click();
  await typeInEditor(page, 'a b\nc');
  await expect(page.locator('.cm-highlightSpace')).toHaveCount(1);
  await expect(page.locator('.cm-eolMarker')).toHaveCount(1);
  await page.keyboard.press('Control+s');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const size = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size'));
  expect(size.trim()).toBe('15px');
  await expect(page.locator('.cm-eolMarker')).toHaveCount(1);
});

test('メニューをキーボードで操作できる', async ({ page }) => {
  await openApp(page);
  await page.getByRole('menuitem', { name: 'ファイル' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menu')).toHaveAttribute('aria-label', '編集');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('編集モードを手動で切り替えられる', async ({ page }) => {
  await openApp(page);
  await page.locator('.status-mode').click();
  await page.getByRole('menuitemcheckbox', { name: 'HTML' }).click();
  await expect(page.locator('.status-mode')).toHaveText('HTML');
});

test('狭い画面でもレイアウトが崩れない', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 640 });
  await openApp(page);
  await typeInEditor(page, 'スマートフォン幅');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.locator('.statusbar')).toBeInViewport();
  await expect(page.locator('.cm-editor')).toBeInViewport();
});
