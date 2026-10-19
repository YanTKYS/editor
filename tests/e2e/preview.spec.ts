import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

test('Markdown プレビューを表示し、スクリプトを実行しない', async ({ page }) => {
  await openApp(page);
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.keyboard.press('F2');
  await page.getByRole('dialog').getByRole('textbox').fill('test.md');
  await page.keyboard.press('Enter');
  await page.locator('.cm-content').click();
  const md = [
    '# 見出し',
    '',
    '**太字**',
    '',
    '<script>window.__xss = 1</script>',
    '<img src="x" onerror="window.__xss = 2">',
    '[link](javascript:window.__xss=3)',
    '<a href="https://example.com" onclick="window.__xss=4">ok</a>',
  ].join('\n');
  await page.evaluate((text) => {
    const app = (window as unknown as { __editorApp: { editor: { view: { dispatch(s: unknown): void } } } }).__editorApp;
    app.editor.view.dispatch({ changes: { from: 0, insert: text } });
  }, md);
  const preview = page.locator('.md-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('h1')).toHaveText('見出し');
  await expect(preview.locator('strong')).toHaveText('太字');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await preview.innerHTML()).not.toMatch(/onerror|onclick|<script|href="javascript:/i);
  expect(dialogs).toEqual([]);

  // 表示切替
  await page.keyboard.press('Alt+p');
  await expect(preview).toBeHidden();
  await page.keyboard.press('Alt+p');
  await expect(preview).toBeVisible();
});
