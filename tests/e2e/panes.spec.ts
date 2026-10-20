import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { editorText, openApp } from './helpers';

const pane = (page: Page, i: number) => page.locator(`.pane[data-pane="${i}"]`);
const paneEditor = (page: Page, i: number) => pane(page, i).locator('.cm-content');
const visiblePanes = (page: Page) => page.locator('.pane:not([hidden])');

interface AppHandle {
  layout: { count: number; active: number; tabs: (string | null)[] };
  store: { all: { id: string; name: string }[]; activeTabId: string | null };
  editor: { getContent(id: string): string };
}

/** ペインに表示しているタブの本文（空のペインは null） */
async function paneText(page: Page, i: number): Promise<string | null> {
  return page.evaluate((i) => {
    const app = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    const id = app.layout.tabs[i];
    return id ? app.editor.getContent(id) : null;
  }, i);
}

async function layoutState(page: Page) {
  return page.evaluate(() => {
    const app = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    const name = (id: string | null) => (id ? app.store.all.find((t) => t.id === id)?.name ?? '?' : null);
    return { count: app.layout.count, active: app.layout.active, tabs: app.layout.tabs.map(name) };
  });
}

/** 名前付きのタブを作成する（1 つ目は既存の空タブを使う） */
async function createTabs(page: Page, tabs: [string, string][]) {
  for (let i = 0; i < tabs.length; i++) {
    if (i > 0) await page.keyboard.press('Alt+n');
    await page.keyboard.press('F2');
    await page.getByRole('dialog').getByRole('textbox').fill(tabs[i][0]);
    await page.keyboard.press('Enter');
    await page.keyboard.type(tabs[i][1]);
  }
}

async function setSplit(page: Page, n: number) {
  await page.locator(`.split-button[data-split="${n}"]`).click();
  await expect(visiblePanes(page)).toHaveCount(n);
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('1〜4 分割を切り替え、各ペインが等幅で並ぶ', async ({ page }) => {
  await createTabs(page, [
    ['a.txt', 'AAA'],
    ['b.txt', 'BBB'],
    ['c.txt', 'CCC'],
    ['d.txt', 'DDD'],
  ]);
  for (const n of [2, 3, 4, 1]) {
    await setSplit(page, n);
    await expect(page.locator(`.split-button[data-split="${n}"]`)).toHaveAttribute('aria-pressed', 'true');
    const boxes = await visiblePanes(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
    const grid = await page.locator('.pane-grid').boundingBox();
    const widths = boxes.map((b) => b.width);
    for (const w of widths) expect(Math.abs(w - widths[0])).toBeLessThanOrEqual(1);
    expect(Math.abs(widths.reduce((a, b) => a + b, 0) - grid!.width)).toBeLessThanOrEqual(2);
    // 左から右へ並ぶ
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].left).toBeGreaterThan(boxes[i - 1].left);
  }
  // 表示メニューからも切り替えられる
  await page.getByRole('menuitem', { name: '表示' }).click();
  await page.getByRole('menuitemcheckbox', { name: '3 分割' }).click();
  await expect(visiblePanes(page)).toHaveCount(3);

  // 画面サイズを変えても等幅を維持する
  await page.setViewportSize({ width: 1000, height: 600 });
  const widths = await visiblePanes(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  for (const w of widths) expect(Math.abs(w - widths[0])).toBeLessThanOrEqual(1);
});

test('分割直後は既存のタブを順に割り当て、足りないペインは空にして案内を表示する', async ({ page }) => {
  await createTabs(page, [
    ['a.txt', 'A'],
    ['b.txt', 'B'],
  ]);
  await page.locator('.tab', { hasText: 'a.txt' }).click();
  await setSplit(page, 4);
  expect(await layoutState(page)).toEqual({ count: 4, active: 0, tabs: ['a.txt', 'b.txt', null, null] });
  await expect(pane(page, 2).locator('.pane-empty')).toBeVisible();
  await expect(pane(page, 2)).toContainText('タブバーのタブをクリックするか、ここへドラッグしてください');
  await expect(pane(page, 0).locator('.pane-title')).toHaveText('● a.txt');
  // 空のペインからタブを選ぶ
  await pane(page, 3).getByRole('button', { name: 'タブを選択…' }).click();
  await page.getByRole('menuitemcheckbox', { name: /a\.txt/ }).click();
  expect(await layoutState(page)).toEqual({ count: 4, active: 3, tabs: [null, 'b.txt', null, 'a.txt'] });
});

test('各ペインで別のタブを独立して編集でき、アクティブペインが区別される', async ({ page }) => {
  await createTabs(page, [
    ['a.txt', 'A'],
    ['b.txt', 'B'],
    ['c.txt', 'C'],
  ]);
  await page.locator('.tab', { hasText: 'a.txt' }).click();
  await setSplit(page, 3);
  await paneEditor(page, 1).click();
  await expect(pane(page, 1)).toHaveClass(/active/);
  await expect(pane(page, 0)).not.toHaveClass(/active/);
  await page.keyboard.press('Control+End');
  await page.keyboard.type('-2');
  await paneEditor(page, 2).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('-3');
  expect(await paneText(page, 0)).toBe('A');
  expect(await paneText(page, 1)).toBe('B-2');
  expect(await paneText(page, 2)).toBe('C-3');
  // ステータスバー・タブバーはアクティブペインのタブを示す
  await expect(page.locator('.tab.active .tab-label')).toHaveText('c.txt');
  await expect(page.locator('.status-pos')).toHaveText('行 1, 列 4');
  // Alt+数字でペインを移動
  await page.keyboard.press('Alt+1');
  await expect(pane(page, 0)).toHaveClass(/active/);
  await expect(paneEditor(page, 0)).toBeFocused();
});

test('タブのクリック・ドラッグ＆ドロップでペイン間を移動する', async ({ page }) => {
  await createTabs(page, [
    ['a.txt', 'A'],
    ['b.txt', 'B'],
    ['c.txt', 'C'],
  ]);
  await page.locator('.tab', { hasText: 'a.txt' }).click();
  await setSplit(page, 2);
  expect(await layoutState(page)).toEqual({ count: 2, active: 0, tabs: ['a.txt', 'b.txt'] });

  // 別のペインに表示中のタブをクリック → そのペインへフォーカス
  await page.locator('.tab', { hasText: 'b.txt' }).click();
  expect(await layoutState(page)).toEqual({ count: 2, active: 1, tabs: ['a.txt', 'b.txt'] });
  await expect(page.locator('.tab', { hasText: 'b.txt' }).locator('.tab-pane')).toHaveText('2');

  // 未表示のタブをクリック → アクティブペインに表示
  await page.locator('.tab', { hasText: 'c.txt' }).click();
  expect(await layoutState(page)).toEqual({ count: 2, active: 1, tabs: ['a.txt', 'c.txt'] });

  // ドラッグ＆ドロップで移動（元のペインからは外れる）
  await page.locator('.tab', { hasText: 'c.txt' }).dragTo(pane(page, 0).locator('.pane-body'));
  expect(await layoutState(page)).toEqual({ count: 2, active: 0, tabs: ['c.txt', null] });
  expect(await paneText(page, 0)).toBe('C');
  // ドロップしても本文には挿入されない
  expect(await editorText(page)).toBe('C');
  await expect(page.locator('.tab', { hasText: 'b.txt' }).locator('.tab-pane')).toBeHidden();
});

test('分割数を減らしてもタブ・編集内容・Undo 履歴は失われない', async ({ page }) => {
  await createTabs(page, [
    ['a.txt', 'A'],
    ['b.txt', 'B'],
    ['c.txt', 'C'],
    ['d.txt', 'D'],
  ]);
  await page.locator('.tab', { hasText: 'a.txt' }).click();
  await setSplit(page, 4);
  await paneEditor(page, 3).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('-edit');
  expect(await paneText(page, 3)).toBe('D-edit');

  await setSplit(page, 2);
  expect(await layoutState(page)).toEqual({ count: 2, active: 1, tabs: ['a.txt', 'b.txt'] });
  await expect(page.locator('.tab')).toHaveCount(4);

  // 閉じたペインのタブを残ったペインで開き、Undo できる
  await page.locator('.tab', { hasText: 'd.txt' }).click();
  expect(await layoutState(page)).toEqual({ count: 2, active: 1, tabs: ['a.txt', 'd.txt'] });
  expect(await editorText(page)).toBe('D-edit');
  await paneEditor(page, 1).click();
  await page.keyboard.press('Control+z');
  expect(await editorText(page)).toBe('D');
  await page.keyboard.press('Control+y');
  expect(await editorText(page)).toBe('D-edit');
});

test('ペインに表示中のタブを閉じると、近くの未表示タブ（なければ空）を表示する', async ({ page }) => {
  await createTabs(page, [
    ['a.txt', ''],
    ['b.txt', ''],
    ['c.txt', ''],
  ]);
  await page.locator('.tab', { hasText: 'a.txt' }).click();
  await setSplit(page, 2);
  await page.locator('.tab', { hasText: 'b.txt' }).locator('.tab-close').click();
  expect(await layoutState(page)).toEqual({ count: 2, active: 0, tabs: ['a.txt', 'c.txt'] });
  await page.locator('.tab', { hasText: 'c.txt' }).locator('.tab-close').click();
  expect(await layoutState(page)).toEqual({ count: 2, active: 0, tabs: ['a.txt', null] });
});

test('再読み込み後に分割数・各ペインのタブ・アクティブペインを復元する', async ({ page }) => {
  await createTabs(page, [
    ['a.txt', 'A'],
    ['b.txt', 'B'],
    ['c.txt', 'C'],
  ]);
  await page.locator('.tab', { hasText: 'a.txt' }).click();
  await setSplit(page, 3);
  await page.locator('.tab', { hasText: 'a.txt' }).dragTo(pane(page, 2).locator('.pane-body'));
  await paneEditor(page, 1).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('!');
  const before = await layoutState(page);
  expect(before).toEqual({ count: 3, active: 1, tabs: [null, 'b.txt', 'a.txt'] });

  await page.reload();
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  expect(await layoutState(page)).toEqual(before);
  await expect(visiblePanes(page)).toHaveCount(3);
  await expect(page.locator('.split-button[data-split="3"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await paneText(page, 1)).toBe('B!');
  expect(await paneText(page, 2)).toBe('A');
  await expect(pane(page, 0).locator('.pane-empty')).toBeVisible();
  await expect(paneEditor(page, 1)).toBeFocused();
});

test('検索・置換はアクティブペインを対象とし、全タブ検索は全タブを対象とする', async ({ page }) => {
  await createTabs(page, [
    ['a.txt', 'foo a'],
    ['b.txt', 'foo b'],
    ['c.txt', 'foo c'],
  ]);
  await page.locator('.tab', { hasText: 'a.txt' }).click();
  await setSplit(page, 2);
  await paneEditor(page, 1).click();
  await page.keyboard.press('Control+h');
  await page.getByRole('textbox', { name: '検索する文字列' }).fill('foo');
  await expect(page.locator('.find-count')).toHaveText(/1 件/);
  // 検索の強調表示はアクティブペインだけ
  await expect(pane(page, 1).locator('.cm-searchMatch')).toHaveCount(1);
  await expect(pane(page, 0).locator('.cm-searchMatch')).toHaveCount(0);
  await page.getByRole('textbox', { name: '置換後の文字列' }).fill('bar');
  await page.locator('.find-panel').getByRole('button', { name: 'すべて置換', exact: true }).click();
  expect(await paneText(page, 0)).toBe('foo a');
  expect(await paneText(page, 1)).toBe('bar b');

  // 全タブ検索は表示していないタブ（c.txt）も対象
  await page.getByRole('textbox', { name: '検索する文字列' }).fill('foo');
  await page.getByRole('button', { name: '全タブ検索' }).click();
  await expect(page.locator('.results-title')).toHaveText('「foo」の検索結果: 2 件（2 タブ）');
  // 結果から未表示のタブへ移動するとアクティブペインに表示する
  await page.locator('.result-item', { hasText: 'foo c' }).click();
  expect(await layoutState(page)).toEqual({ count: 2, active: 1, tabs: ['a.txt', 'c.txt'] });
  // 結果から他のペインのタブへ移動するとそのペインへフォーカス
  await page.locator('.result-item', { hasText: 'foo a' }).click();
  expect((await layoutState(page)).active).toBe(0);
  await expect(paneEditor(page, 0)).toBeFocused();
});

test('ファイルの書き出しはアクティブペインのタブを対象とする', async ({ page }) => {
  await createTabs(page, [
    ['left.txt', '左'],
    ['right.txt', '右'],
  ]);
  await page.locator('.tab', { hasText: 'left.txt' }).click();
  await setSplit(page, 2);
  await paneEditor(page, 1).click();
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+Shift+s');
  const file = await download;
  expect(file.suggestedFilename()).toBe('right.txt');
  expect((await readFile(await file.path())).toString('utf-8')).toBe('右');
});

test('狭い画面ではペインを極端に狭くせず横スクロールする', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 600 });
  await createTabs(page, [
    ['a.txt', 'A'],
    ['b.txt', 'B'],
  ]);
  await setSplit(page, 4);
  const widths = await visiblePanes(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  for (const w of widths) expect(w).toBeGreaterThanOrEqual(200);
  const grid = await page.locator('.pane-grid').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(grid.sw).toBeGreaterThan(grid.cw);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('v0.1.0 の保存データを移行して読み込む', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.clear();
    const tab = (id: string, name: string) => ({
      id,
      name,
      mode: 'plaintext',
      eol: 'LF',
      encoding: 'UTF-8',
      bom: false,
      modifiedSinceFile: false,
      createdAt: 1,
      updatedAt: 1,
    });
    localStorage.setItem(
      'webTextEditor:meta',
      JSON.stringify({
        schemaVersion: 1,
        app: 'web-text-editor',
        revision: 3,
        writerId: 'v010',
        savedAt: 1,
        activeTabId: 't2',
        tabs: [tab('t1', '一つ目.txt'), tab('t2', '二つ目.txt')],
        settings: { theme: 'light', fontSize: 14, tabSize: 4 },
      }),
    );
    localStorage.setItem('webTextEditor:tab:t1', '旧データ1');
    localStorage.setItem('webTextEditor:tab:t2', '旧データ2');
  });
  await page.reload();
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  expect(await layoutState(page)).toEqual({ count: 1, active: 0, tabs: ['二つ目.txt'] });
  expect(await editorText(page)).toBe('旧データ2');
  await setSplit(page, 2);
  expect(await paneText(page, 1)).toBe('旧データ1');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.status-save')).toHaveText('ブラウザ保存済');
  const meta = await page.evaluate(() => JSON.parse(localStorage.getItem('webTextEditor:meta')!));
  expect(meta.schemaVersion).toBe(2);
  expect(meta.layout.count).toBe(2);
  expect(meta.revision).toBe(4);
});

test('Markdown プレビューはアクティブペインのタブを表示し、ペインの等幅を保つ', async ({ page }) => {
  await createTabs(page, [
    ['memo.md', '# 見出しA'],
    ['plain.txt', 'text'],
    ['other.md', '# 見出しB'],
  ]);
  await page.locator('.tab', { hasText: 'memo.md' }).click();
  await setSplit(page, 3);
  const preview = page.locator('.md-preview');
  await paneEditor(page, 0).click();
  await expect(preview.locator('h1')).toHaveText('見出しA');
  await paneEditor(page, 1).click();
  await expect(preview).toBeHidden();
  await paneEditor(page, 2).click();
  await expect(preview.locator('h1')).toHaveText('見出しB');
  const widths = await visiblePanes(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  for (const w of widths) expect(Math.abs(w - widths[0])).toBeLessThanOrEqual(1);
});

test('バックアップに画面分割を含め、復元時に再現する', async ({ page }) => {
  await createTabs(page, [
    ['a.txt', 'A'],
    ['b.txt', 'B'],
  ]);
  await page.locator('.tab', { hasText: 'a.txt' }).click();
  await setSplit(page, 2);
  await page.locator('.tab', { hasText: 'b.txt' }).click();
  await page.getByRole('menuitem', { name: 'ファイル' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /バックアップを書き出し/ }).click();
  const json = await readFile(await (await download).path(), 'utf-8');
  expect(JSON.parse(json).layout).toEqual({ count: 2, panes: [0, 1], active: 1 });

  await setSplit(page, 1);
  await page.getByRole('menuitem', { name: 'ファイル' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'バックアップから復元…' }).click();
  await (await chooser).setFiles([{ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(json) }]);
  await page.getByRole('dialog').getByRole('button', { name: '置き換える' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '上書きする' }).click();
  expect(await layoutState(page)).toEqual({ count: 2, active: 1, tabs: ['a.txt', 'b.txt'] });
  expect(await paneText(page, 0)).toBe('A');
  expect(await editorText(page)).toBe('B');
});
