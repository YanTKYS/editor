import { expect, test, type Page } from '@playwright/test';
import type { SearchOptions } from '../../src/core/search';
import { openApp, typeInEditor } from './helpers';

interface AppHandle {
  store: { all: { id: string; name: string }[]; rename(id: string, name: string): void; remove(id: string): void };
  editor: {
    getContent(id: string): string;
    applyToTab(id: string, build: () => { changes: { from: number; insert: string } }): void;
  };
  search: { onQueryChange(options: SearchOptions): void };
  findPanel: { options: SearchOptions };
  newTab(): void;
  addTab(init: { name: string }, content: string): void;
}

const dialog = (page: Page) => page.getByRole('dialog');
const content = (page: Page) => page.evaluate(() => {
  const app = (window as unknown as { __editorApp: AppHandle }).__editorApp;
  return app.store.all.map(t => app.editor.getContent(t.id));
});
async function prepare(page: Page) {
  await openApp(page);
  await typeInEditor(page, 'foo');
  await page.keyboard.press('Alt+n');
  await page.keyboard.type('foo foo');
  await page.keyboard.press('Control+h');
  await page.getByRole('textbox', { name: '検索する文字列' }).fill('foo');
  await page.getByRole('textbox', { name: '置換後の文字列' }).fill('bar');
}
async function preview(page: Page) {
  await page.getByRole('button', { name: '全タブをすべて置換', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

test('ファイルごとの位置と変更前後を確認でき、キャンセル・確定・Undo/Redoが動作する', async ({ page }) => {
  await prepare(page);
  await preview(page);
  await expect(dialog(page)).toContainText('2 個のタブで合計 3 件');
  await expect(dialog(page).getByRole('heading', { level: 3 })).toHaveText(['タブ 1 — 新規 1（1 件）', 'タブ 2 — 新規 2（2 件）']);
  await expect(dialog(page).locator('.replace-preview-example')).toHaveCount(3);
  await expect(dialog(page)).toContainText('行 1, 列 5（置換前）');
  await expect(dialog(page).locator('.replace-preview-pair').first()).toContainText('変更前foo変更後bar');
  expect(await content(page)).toEqual(['foo', 'foo foo']);
  await dialog(page).getByRole('button', { name: 'キャンセル' }).click();
  expect(await content(page)).toEqual(['foo', 'foo foo']);
  await preview(page);
  await dialog(page).getByRole('button', { name: '置換する', exact: true }).click();
  expect(await content(page)).toEqual(['bar', 'bar bar']);
  for (const index of [1, 0]) {
    await page.locator('.tab').nth(index).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+z');
    expect((await content(page))[index]).toBe(index === 0 ? 'foo' : 'foo foo');
    await page.keyboard.press('Control+y');
    expect((await content(page))[index]).toBe(index === 0 ? 'bar' : 'bar bar');
  }
});

for (const change of ['本文', '検索語', '置換文字列', '検索オプション', 'タブ追加', 'タブ削除', '名前変更'] as const) {
  test(`プレビュー後の${change}の変更で全タブ置換を止める`, async ({ page }) => {
    await prepare(page);
    await preview(page);
    await page.evaluate(change => {
      const app = (window as unknown as { __editorApp: AppHandle }).__editorApp;
      const id = app.store.all[0].id;
      if (change === '本文') app.editor.applyToTab(id, () => ({ changes: { from: 0, insert: '追記 ' } }));
      else if (change === 'タブ追加') app.newTab();
      else if (change === 'タブ削除') app.store.remove(id);
      else if (change === '名前変更') app.store.rename(id, 'changed.txt');
      else app.search.onQueryChange({ ...app.findPanel.options, ...(change === '検索語' ? { search: 'foo foo' } : change === '置換文字列' ? { replace: 'other' } : { caseSensitive: true }) });
    }, change);
    const changed = await content(page);
    await dialog(page).getByRole('button', { name: '置換する', exact: true }).click();
    await expect(dialog(page).getByRole('alert')).toContainText('プレビューを作り直してください');
    expect(await content(page)).toEqual(changed);
    await dialog(page).getByRole('button', { name: 'キャンセル' }).click();
    expect(await content(page)).toEqual(changed);
    if (change === '本文') {
      await preview(page);
      await expect(dialog(page)).toContainText('追記 foo');
      await dialog(page).getByRole('button', { name: '置換する', exact: true }).click();
      expect(await content(page)).toEqual(['追記 bar', 'bar bar']);
    }
  });
}

test('多数のタブ・一致・長い文字列の省略を明示し、省略分もすべて置換する', async ({ page }) => {
  await prepare(page);
  await page.getByRole('textbox', { name: '置換後の文字列' }).fill('y'.repeat(300));
  await page.evaluate(() => {
    const app = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    for (let i = 0; i < 22; i++) app.addTab({ name: '同名.txt' }, 'foo '.repeat(8));
  });
  await preview(page);
  await expect(dialog(page).locator('.replace-preview-file')).toHaveCount(20);
  await expect(dialog(page)).toContainText('ほか 4 タブは表示を省略');
  await expect(dialog(page)).toContainText('ほか 3 件は表示を省略');
  await expect(dialog(page)).toContainText('省略分を含む全 179 件が置換対象');
  await expect(dialog(page).locator('.replace-preview-pair pre').nth(1)).toHaveText('y'.repeat(200) + '…');
  expect((await content(page))[2]).toBe('foo '.repeat(8));
  await dialog(page).getByRole('button', { name: '置換する', exact: true }).click();
  expect((await content(page))[23]).toBe(('y'.repeat(300) + ' ').repeat(8));
});

test('正規表現の参照・改行と削除のプレビューを実際の結果に合わせる', async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, 'id=12');
  await page.keyboard.press('Control+h');
  await page.getByRole('button', { name: '正規表現', exact: true }).click();
  await page.getByRole('textbox', { name: '検索する文字列' }).fill('(id=)(\\d+)');
  await page.getByRole('textbox', { name: '置換後の文字列' }).fill('$2\\n$1');
  await preview(page);
  await expect(dialog(page).locator('.replace-preview-pair pre').nth(1)).toHaveText('12\nid=');
  await dialog(page).getByRole('button', { name: '置換する', exact: true }).click();
  expect(await content(page)).toEqual(['12\nid=']);
  await page.getByRole('textbox', { name: '検索する文字列' }).fill('id=');
  await page.getByRole('textbox', { name: '置換後の文字列' }).fill('');
  await preview(page);
  await expect(dialog(page).locator('.replace-preview-pair pre').nth(1)).toHaveText('（空文字）');
  await page.keyboard.press('Escape');
  expect(await content(page)).toEqual(['12\nid=']);
});
