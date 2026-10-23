import { expect, test, type Page } from '@playwright/test';
import { openApp, saveNow, typeInEditor } from './helpers';

async function rename(page: Page, name: string) {
  await page.keyboard.press('F2');
  await page.getByRole('dialog').getByRole('textbox').fill(name);
  await page.keyboard.press('Enter');
}

const target = (page: Page) => page.locator('.operation-target');
const fileState = (page: Page) => page.locator('.operation-file-state');

test('自動保存とファイル書き出しの状態を区別し、再読み込み後も保持する', async ({ page }) => {
  await openApp(page);
  await expect(fileState(page)).toHaveText('ファイル変更なし');
  await rename(page, 'memo.txt');
  await typeInEditor(page, '保存する文章');
  await saveNow(page);
  await expect(fileState(page)).toHaveText('ファイル未書き出し ●');
  await expect(page.getByRole('tab', { name: /memo.txt、ファイル未書き出し/ })).toBeVisible();
  await page.reload();
  await expect(target(page)).toHaveText('操作対象：ペイン 1 — memo.txt');
  await expect(fileState(page)).toHaveText('ファイル未書き出し ●');
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+Shift+s');
  expect((await download).suggestedFilename()).toBe('memo.txt');
  await expect(fileState(page)).toHaveText('ファイル変更なし');
  await expect(page.locator('.tab.active')).not.toHaveClass(/modified/);
  await typeInEditor(page, '追記');
  await expect(fileState(page)).toHaveText('ファイル未書き出し ●');
});

test('検索中のペイン切り替え・名前変更・空ペインに操作対象が追従する', async ({ page }) => {
  await openApp(page);
  await rename(page, 'a.txt');
  await typeInEditor(page, 'apple');
  await page.keyboard.press('Alt+n');
  await rename(page, 'b.txt');
  await typeInEditor(page, 'banana');
  await page.locator('.split-button[data-split="3"]').click();
  await page.keyboard.press('Control+h');
  await expect(page.locator('.find-scope')).toHaveText('このタブ内');
  await expect(page.getByRole('button', { name: 'このタブをすべて置換', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '全タブをすべて置換', exact: true })).toBeVisible();
  await expect(target(page)).toHaveText('操作対象：ペイン 1 — b.txt');
  await page.keyboard.press('Alt+2');
  await expect(target(page)).toHaveText('操作対象：ペイン 2 — a.txt');
  await rename(page, 'renamed.txt');
  await expect(target(page)).toHaveText('操作対象：ペイン 2 — renamed.txt');
  await page.getByRole('button', { name: 'タブ一覧', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: /renamed.txt — ペイン 2/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+3');
  await expect(target(page)).toHaveText('操作対象：ペイン 3 — タブなし');
  await expect(fileState(page)).toBeHidden();
  await page.keyboard.press('Alt+1');
  await expect(target(page)).toHaveText('操作対象：ペイン 1 — b.txt');
  await expect(fileState(page)).toBeVisible();
});

test('差分結果は読み取り専用と表示し、終了すると操作対象を復元する', async ({ page }) => {
  await openApp(page);
  await rename(page, 'before.txt');
  await typeInEditor(page, 'before');
  await page.keyboard.press('Alt+n');
  await rename(page, 'after.txt');
  await typeInEditor(page, 'after');
  await page.getByRole('menuitem', { name: '表示', exact: true }).click();
  await page.getByRole('menuitem', { name: '差分比較…', exact: true }).click();
  await page.getByRole('button', { name: '比較する', exact: true }).click();
  await page.keyboard.press('Alt+3');
  await expect(target(page)).toHaveText('操作対象：ペイン 3 — 差分結果（読み取り専用）');
  await expect(fileState(page)).toBeHidden();
  await page.getByRole('button', { name: '比較終了', exact: true }).click();
  await expect(target(page)).toHaveText('操作対象：ペイン 1 — after.txt');
  await expect(fileState(page)).toHaveText('ファイル未書き出し ●');
});

test('狭い画面でも長いファイル名と状態表示が重ならない', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await openApp(page);
  await rename(page, `${'長いファイル名'.repeat(20)}.txt`);
  await typeInEditor(page, '本文');
  await expect(fileState(page)).toBeVisible();
  const a = await target(page).boundingBox();
  const b = await fileState(page).boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x);
  expect(b!.x + b!.width).toBeLessThanOrEqual(375);
});
