import { expect, test, type Page } from '@playwright/test';
import type { EditorState } from '@codemirror/state';
import type { TabMeta } from '../../src/core/types';
import { openApp, typeInEditor } from './helpers';

interface AppHandle {
  editor: {
    view: { state: EditorState };
    applyToTab(id: string, build: () => { changes: { from: number; insert: string } }): boolean;
  };
  store: {
    all: readonly TabMeta[];
    activeTabId: string | null;
    reset(tabs: TabMeta[], activeId: string | null): void;
  };
}

const notice = (page: Page) => page.locator('.results-notice');
const input = (page: Page) => page.getByRole('textbox', { name: '検索する文字列' });
const results = (page: Page) => page.locator('.results-panel');
const refresh = (page: Page) => results(page).getByRole('button', { name: '再検索', exact: true });

async function search(page: Page, text = 'foo') {
  await page.keyboard.press('Control+h');
  await input(page).fill(text);
  await page.getByRole('button', { name: '全タブ検索', exact: true }).click();
  await expect(results(page)).toBeVisible();
  await expect(notice(page)).toBeHidden();
}

test('本文変更後は検索時の一覧を残し、移動を止め、再検索で更新する', async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, 'foo');
  await search(page);
  await page.locator('.cm-content').fill('前の行\nfoo foo');
  await expect(notice(page)).toBeVisible();
  await expect(page.locator('.results-title')).toHaveText('全タブの検索結果「foo」: 1 件（1 タブ）');
  const before = await page.evaluate(() => (window as unknown as { __editorApp: AppHandle }).__editorApp.editor.view.state.selection.toJSON());
  await page.locator('.result-item').click();
  await expect(page.locator('.toast').last()).toContainText('「再検索」で更新してください');
  expect(await page.evaluate(() => (window as unknown as { __editorApp: AppHandle }).__editorApp.editor.view.state.selection.toJSON())).toEqual(before);
  await refresh(page).click();
  await expect(notice(page)).toBeHidden();
  await expect(page.locator('.result-item')).toHaveCount(2);
  await page.locator('.result-item').first().click();
  await expect(page.locator('.status-pos')).toContainText('行 2');
});

test('検索条件だけを変更しても古くなり、不正な条件では解除しない', async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, 'foo Foo food');
  await search(page);
  // 置換文字列とカーソル移動は検索結果を変えない。
  await page.getByRole('textbox', { name: '置換後の文字列' }).fill('bar');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ArrowLeft');
  await expect(notice(page)).toBeHidden();
  for (const name of ['大文字と小文字を区別', '単語単位で検索', '正規表現']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(notice(page)).toBeVisible();
    await refresh(page).click();
    await expect(notice(page)).toBeHidden();
  }
  await input(page).fill('(');
  await expect(notice(page)).toBeVisible();
  await refresh(page).click();
  await expect(notice(page)).toBeVisible();
  await expect(page.locator('.results-title')).toContainText('「foo」');
  await input(page).fill('');
  await refresh(page).click();
  await expect(notice(page)).toBeVisible();
  await input(page).fill('zzz');
  await refresh(page).click();
  await expect(notice(page)).toBeHidden();
  await expect(page.locator('.results-empty')).toBeVisible();
  await page.locator('.cm-content').fill('zzz');
  await expect(notice(page)).toBeVisible();
  await refresh(page).click();
  await expect(page.locator('.result-item')).toHaveCount(1);
});

test('タブの追加・名前変更・削除・復元を検知し、切り替えは除外する', async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, 'foo');
  await page.keyboard.press('Alt+n');
  await page.keyboard.type('foo');
  await search(page);
  await page.locator('.tab').first().click();
  await expect(notice(page)).toBeHidden();
  await page.locator('.split-button[data-split="2"]').click();
  await page.keyboard.press('Alt+2');
  await expect(notice(page)).toBeHidden();
  await page.keyboard.press('F2');
  await page.getByRole('dialog').getByRole('textbox').fill('renamed.txt');
  await page.keyboard.press('Enter');
  await expect(notice(page)).toBeVisible();
  await refresh(page).click();
  await expect(notice(page)).toBeHidden();
  await expect(page.locator('.results-tab')).toContainText(['新規 1', 'renamed.txt']);
  await page.keyboard.press('Alt+n');
  await expect(notice(page)).toBeVisible();
  await refresh(page).click();
  await expect(notice(page)).toBeHidden();
  await page.keyboard.press('Alt+w'); // 空の新規タブを閉じる
  await expect(notice(page)).toBeVisible();
  await refresh(page).click();
  await expect(notice(page)).toBeHidden();
  // バックアップ復元でも使われるタブ全置換の通知経路を確認する。
  await page.evaluate(() => {
    const app = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    app.store.reset([...app.store.all], app.store.activeTabId);
  });
  await expect(notice(page)).toBeVisible();
});

test('非アクティブなタブの本文変更も検知し、全タブ置換後は最新の結果に戻る', async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, 'foo');
  await page.keyboard.press('Alt+n');
  await page.keyboard.type('foo');
  await search(page);
  await page.evaluate(() => {
    const app = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    app.editor.applyToTab(app.store.all[0].id, () => ({ changes: { from: 0, insert: 'foo ' } }));
  });
  await expect(notice(page)).toBeVisible();
  await refresh(page).click();
  await expect(notice(page)).toBeHidden();
  await expect(page.locator('.result-item')).toHaveCount(3);
  await page.getByRole('textbox', { name: '置換後の文字列' }).fill('bar');
  await page.getByRole('button', { name: '全タブをすべて置換', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '置換する', exact: true }).click();
  await expect(notice(page)).toBeHidden();
  await expect(page.locator('.results-empty')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await expect(notice(page)).toBeVisible();
});
