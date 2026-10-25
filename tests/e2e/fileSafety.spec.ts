import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { activeTab, editorText, openApp, tabs, typeInEditor } from './helpers';

interface App {
  addTab(init: { name: string; modifiedSinceFile: boolean }, content: string): { id: string };
  activateTab(id: string, focus?: boolean): void;
  closeOtherTabs(id: string): Promise<void>;
  store: { all: { id: string }[] };
  files: { openFiles(files: File[], encoding: 'UTF-8'): Promise<void> };
}

test.beforeEach(async ({ page }) => { await openApp(page); });

for (const otherTabs of [false, true]) {
  test(`本文を全削除した未書き出しタブも閉じる前に確認する（他のタブ: ${otherTabs}）`, async ({ page }) => {
    await page.evaluate(() => {
      const app = (window as unknown as { __editorApp: App }).__editorApp;
      app.activateTab(app.addTab({ name: '業務メモ.txt', modifiedSinceFile: false }, '元の本文').id, true);
    });
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    expect(await editorText(page)).toBe('');
    const close = async () => {
      if (otherTabs) {
        await page.evaluate(() => {
          const app = (window as unknown as { __editorApp: App }).__editorApp;
          void app.closeOtherTabs(app.store.all[0].id);
        });
      } else await page.keyboard.press('Alt+w');
    };
    await close();
    await expect(page.getByRole('dialog')).toContainText('書き出されてい');
    await page.getByRole('dialog').getByRole('button', { name: 'キャンセル', exact: true }).click();
    await expect(tabs(page)).toHaveCount(2);
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+z');
    expect(await editorText(page)).toBe('元の本文');
    await page.keyboard.press('Control+y');
    expect(await editorText(page)).toBe('');
    await close();
    if (otherTabs) {
      await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
    } else {
      const download = page.waitForEvent('download');
      await page.getByRole('dialog').getByRole('button', { name: '書き出してから閉じる', exact: true }).click();
      expect(await readFile(await (await download).path(), 'utf8')).toBe('');
    }
    await expect(tabs(page)).toHaveCount(1);
  });
}

test('ファイル読み込み中に新規タブへ入力しても自動で閉じない', async ({ page }) => {
  await page.evaluate(() => {
    const app = (window as unknown as { __editorApp: App }).__editorApp;
    const file = new File(['読み込んだ本文'], 'loaded.txt');
    const read = file.arrayBuffer.bind(file);
    file.arrayBuffer = () => new Promise(resolve => {
      (window as unknown as { finishRead: () => void }).finishRead = () => { void read().then(resolve); };
    });
    void app.files.openFiles([file], 'UTF-8');
  });
  await typeInEditor(page, '読み込み待ちのメモ');
  await page.evaluate(() => (window as unknown as { finishRead: () => void }).finishRead());
  await expect(activeTab(page)).toHaveText('loaded.txt');
  await expect(tabs(page)).toHaveCount(2);
  await tabs(page).filter({ hasText: '新規 1' }).click();
  expect(await editorText(page)).toBe('読み込み待ちのメモ');
  await expect(tabs(page).first()).toHaveClass(/modified/);
  await page.keyboard.press('Control+z');
  expect(await editorText(page)).toBe('');
});

for (const close of [false, true]) {
  test(`書き出し開始に失敗しても本文を残し、エラーを案内する（閉じる: ${close}）`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await typeInEditor(page, '保持する本文');
    await page.evaluate(() => { URL.createObjectURL = () => { throw new Error('download unavailable'); }; });
    if (close) {
      await page.keyboard.press('Alt+w');
      await page.getByRole('dialog').getByRole('button', { name: '書き出してから閉じる', exact: true }).click();
    } else await page.keyboard.press('Control+Shift+s');
    await expect(page.locator('.toast-error')).toContainText('ファイルを書き出せませんでした');
    await expect(tabs(page)).toHaveCount(1);
    await expect(tabs(page).first()).toHaveClass(/modified/);
    expect(await editorText(page)).toBe('保持する本文');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+z');
    expect(await editorText(page)).toBe('');
    expect(errors).toEqual([]);
  });
}
