import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { openApp, typeInEditor } from './helpers';

const toolbar = (page: import('@playwright/test').Page) => page.locator('.toolbar');
const toolbarButton = (page: import('@playwright/test').Page, name: string | RegExp) =>
  typeof name === 'string'
    ? toolbar(page).getByRole('button', { name, exact: true })
    : toolbar(page).getByRole('button', { name });

for (const width of [375, 480]) {
  test(`幅${width}pxで主要操作（開く・書き出し・検索）がツールバー内に収まる`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await openApp(page);
    await expect(toolbar(page)).toBeVisible();
    // 書き出しボタンは ::before の字形がアクセシブルネームに含まれるため正規表現で探す
    for (const name of ['開く', /ファイルに書き出し/, '検索'] as const) {
      const btn = toolbarButton(page, name);
      await expect(btn).toBeVisible();
      const box = await btn.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
    // 副次的な操作は狭幅のツールバーには出さない（編集メニュー・ショートカットで代替できる）
    await expect(toolbarButton(page, '元に戻す')).toBeHidden();
    await expect(toolbarButton(page, 'やり直し')).toBeHidden();
    await expect(page.locator('.split-toggle')).toBeHidden();
    // 置換は 480px では表示し、375px では検索メニューに委ねる
    if (width === 375) {
      await expect(toolbarButton(page, '置換')).toBeHidden();
    } else {
      await expect(toolbarButton(page, '置換')).toBeVisible();
    }
    // 画面全体の横スクロールは生じない
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('幅375pxで主要操作をツールバーから実行できる', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await openApp(page);
  await typeInEditor(page, '狭幅テスト');

  // 検索: パネルが開き、入力欄にフォーカスする
  await toolbarButton(page, '検索').click();
  await expect(page.locator('.find-panel')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '検索する文字列' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.find-panel')).toBeHidden();

  // 開く: ファイル選択ダイアログが開く
  const chooser = page.waitForEvent('filechooser');
  await toolbarButton(page, '開く').click();
  await chooser;

  // 書き出し: ダウンロードが発生する
  const downloadPromise = page.waitForEvent('download');
  await toolbarButton(page, /ファイルに書き出し/).click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());
  expect(bytes.toString('utf-8')).toBe('狭幅テスト');
});

test('幅480pxで小さい操作対象のタップ／クリック領域が確保される', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await openApp(page);

  const tabClose = await page.locator('.tab-close').first().boundingBox();
  expect(tabClose).not.toBeNull();
  expect(tabClose!.width).toBeGreaterThanOrEqual(24);
  expect(tabClose!.height).toBeGreaterThanOrEqual(24);

  const tabList = await page.getByRole('button', { name: 'タブ一覧' }).boundingBox();
  expect(tabList).not.toBeNull();
  expect(tabList!.width).toBeGreaterThanOrEqual(32);

  // ペイン見出しの ▾ は分割時のみ表示される
  await page.getByRole('menuitem', { name: '表示' }).click();
  await page.getByRole('menuitemcheckbox', { name: '2 分割' }).click();
  const panePick = await page.locator('.pane-pick').first().boundingBox();
  expect(panePick).not.toBeNull();
  expect(panePick!.width).toBeGreaterThanOrEqual(28);
  expect(panePick!.height).toBeGreaterThanOrEqual(24);

  await page.keyboard.press('Control+f');
  const findClose = await page.locator('.find-close').first().boundingBox();
  expect(findClose).not.toBeNull();
  expect(findClose!.width).toBeGreaterThanOrEqual(28);
  expect(findClose!.height).toBeGreaterThanOrEqual(28);

  const findExpand = await page.locator('.find-expand').boundingBox();
  expect(findExpand).not.toBeNull();
  expect(findExpand!.width).toBeGreaterThanOrEqual(28);
  expect(findExpand!.height).toBeGreaterThanOrEqual(28);
});

test('通常幅ではツールバーの全操作と従来の表示を維持する', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await expect(toolbarButton(page, '元に戻す')).toBeVisible();
  await expect(toolbarButton(page, 'やり直し')).toBeVisible();
  await expect(toolbarButton(page, '置換')).toBeVisible();
  await expect(page.locator('.split-toggle')).toBeVisible();
  // 狭幅向けの拡大は通常幅には適用されない
  const tabClose = await page.locator('.tab-close').first().boundingBox();
  expect(tabClose).not.toBeNull();
  expect(tabClose!.width).toBeLessThanOrEqual(20);
  expect(tabClose!.height).toBeLessThanOrEqual(20);
});
