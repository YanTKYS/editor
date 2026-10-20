import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { openApp, saveNow } from './helpers';

const pane = (page: Page, i: number) => page.locator(`.pane[data-pane="${i}"]`);
const paneEditor = (page: Page, i: number) => pane(page, i).locator('.cm-content');
const paneLines = (page: Page, i: number) => pane(page, i).locator('.cm-line').allTextContents();
const visiblePanes = (page: Page) => page.locator('.pane:not([hidden])');
const bar = (page: Page) => page.locator('.diff-bar');
const dialog = (page: Page) => page.getByRole('dialog');

interface AppHandle {
  addTab(init: { name: string }, content: string): { id: string };
  activateTab(id: string): void;
  layout: {
    count: number;
    active: number;
    tabs: (string | null)[];
    load(state: { count: number; tabs: (string | null)[]; active: number }, ids: string[]): void;
    show(id: string | null, pane: number, activate?: boolean): void;
  };
  store: { all: { id: string; name: string }[] };
  editor: { getContent(id: string): string };
}
const app = () => (window as unknown as { __editorApp: AppHandle }).__editorApp;

/** 名前付きのタブを作成する（既存の空タブはそのまま残す） */
async function addTabs(page: Page, tabs: [string, string][]): Promise<void> {
  await page.evaluate(
    ([tabs, appFn]) => {
      const a = (new Function(`return (${appFn})()`) as () => AppHandle)();
      for (const [name, content] of tabs) a.activateTab(a.addTab({ name }, content).id);
    },
    [tabs, app.toString()] as const,
  );
}

/** ペイン配置を設定する（タブ名で指定。空のペインは null） */
async function arrange(page: Page, count: number, tabs: (string | null)[], active = 0): Promise<void> {
  await page.evaluate(
    ([count, tabs, active, appFn]) => {
      const a = (new Function(`return (${appFn})()`) as () => AppHandle)();
      const id = (name: string | null) => (name ? (a.store.all.find((t) => t.name === name)?.id ?? null) : null);
      a.layout.load({ count, tabs: tabs.map(id), active }, a.store.all.map((t) => t.id));
    },
    [count, tabs, active, app.toString()] as const,
  );
  await expect(visiblePanes(page)).toHaveCount(count);
}

async function tabText(page: Page, name: string): Promise<string> {
  return page.evaluate(
    ([name, appFn]) => {
      const a = (new Function(`return (${appFn})()`) as () => AppHandle)();
      const tab = a.store.all.find((t) => t.name === name);
      return tab ? a.editor.getContent(tab.id) : '';
    },
    [name, app.toString()] as const,
  );
}

async function layoutNames(page: Page) {
  return page.evaluate((appFn) => {
    const a = (new Function(`return (${appFn})()`) as () => AppHandle)();
    const name = (id: string | null) => (id ? (a.store.all.find((t) => t.id === id)?.name ?? '?') : null);
    return { count: a.layout.count, active: a.layout.active, tabs: a.layout.tabs.map(name) };
  }, app.toString());
}

async function openDiffDialog(page: Page): Promise<void> {
  await page.getByRole('menuitem', { name: '表示' }).click();
  await page.getByRole('menuitem', { name: '差分比較…' }).click();
  await expect(dialog(page)).toBeVisible();
}

/** ダイアログで 3 つのペイン（0 始まり）を選んで比較を開始する。省略した項目は初期値のまま */
async function startDiff(page: Page, panes: { a?: number; b?: number; result?: number } = {}): Promise<void> {
  await openDiffDialog(page);
  const d = dialog(page);
  if (panes.a !== undefined) await d.getByLabel('比較元（変更前）のペイン').selectOption(String(panes.a));
  if (panes.b !== undefined) await d.getByLabel('比較先（変更後）のペイン').selectOption(String(panes.b));
  if (panes.result !== undefined) await d.getByLabel('差分結果を表示するペイン').selectOption(String(panes.result));
  await d.getByRole('button', { name: '比較する' }).click();
  await expect(bar(page)).toBeVisible();
}

const endDiff = (page: Page) => bar(page).getByRole('button', { name: '比較終了' }).click();

const ORIGINAL = '# 設定\ntimeout=30\nretry=3\ndebug=false\nname=editor';
const MODIFIED = '# 設定\ntimeout=60\nretry=3\ndebug=true\ncache=true\nname=editor';
const UNIFIED = ['@@ -2,1 +2,1 @@', '- timeout=30', '+ timeout=60', '', '@@ -4,1 +4,2 @@', '- debug=false', '+ debug=true', '+ cache=true'];

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('1 ペインから 3 ペインに自動で拡張して比較し、終了すると元の 1 ペインに戻る', async ({ page }) => {
  await addTabs(page, [
    ['original.txt', ORIGINAL],
    ['modified.txt', MODIFIED],
  ]);
  await page.locator('.tab', { hasText: 'original.txt' }).click();
  expect(await layoutNames(page)).toEqual({ count: 1, active: 0, tabs: ['original.txt'] });

  // ダイアログでは、ペイン番号と表示中のタブ名を確認でき、何をどこに表示するかが分かる
  await openDiffDialog(page);
  const d = dialog(page);
  await expect(d.getByLabel('比較元（変更前）のペイン').locator('option')).toHaveText([
    'ペイン 1 — original.txt',
    'ペイン 2 — modified.txt',
    'ペイン 3 — 空',
  ]);
  await expect(d.getByLabel('比較元（変更前）のペイン')).toHaveValue('0');
  await expect(d.getByLabel('比較先（変更後）のペイン')).toHaveValue('1');
  await expect(d.getByLabel('差分結果を表示するペイン')).toHaveValue('2');
  await expect(d.getByRole('status')).toContainText('ペイン 1 の「original.txt」（変更前）と、ペイン 2 の「modified.txt」（変更後）を比較し、結果をペイン 3 に表示します');
  await expect(d).toContainText('ペイン数を 3 に拡張して比較します');
  // キャンセルしても、ペイン配置は変わらない
  await d.getByRole('button', { name: 'キャンセル' }).click();
  expect(await layoutNames(page)).toEqual({ count: 1, active: 0, tabs: ['original.txt'] });
  await expect(visiblePanes(page)).toHaveCount(1);
  await expect(bar(page)).toBeHidden();

  await startDiff(page);
  await expect(visiblePanes(page)).toHaveCount(3);
  expect(await layoutNames(page)).toEqual({ count: 3, active: 0, tabs: ['original.txt', 'modified.txt', null] });
  await expect(pane(page, 0).locator('.pane-diff-badge')).toHaveText('比較元');
  await expect(pane(page, 1).locator('.pane-diff-badge')).toHaveText('比較先');
  await expect(pane(page, 2).locator('.pane-diff-badge')).toHaveText('差分結果');
  await expect(pane(page, 2).locator('.pane-title')).toHaveText('差分結果（読み取り専用）');
  await expect(bar(page).locator('.diff-summary')).toHaveText('差分 2 件（追加 0・削除 0・変更 2）');
  expect(await paneLines(page, 2)).toEqual(UNIFIED);
  // タブは増えない
  await expect(page.locator('.tab')).toHaveCount(3);

  await endDiff(page);
  await expect(bar(page)).toBeHidden();
  await expect(visiblePanes(page)).toHaveCount(1);
  expect(await layoutNames(page)).toEqual({ count: 1, active: 0, tabs: ['original.txt'] });
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
  // 本文はそのまま、通常の編集ができる
  await pane(page, 0).locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('!');
  expect(await tabText(page, 'original.txt')).toBe(`${ORIGINAL}!`);
  expect(await tabText(page, 'modified.txt')).toBe(MODIFIED);
});

test('2 ペインは自動で 3 ペインに拡張し、3 つ目を結果表示の初期値にする', async ({ page }) => {
  await addTabs(page, [
    ['original.txt', ORIGINAL],
    ['modified.txt', MODIFIED],
  ]);
  await arrange(page, 2, ['original.txt', 'modified.txt'], 1);
  await startDiff(page);
  expect(await layoutNames(page)).toEqual({ count: 3, active: 0, tabs: ['original.txt', 'modified.txt', null] });
  expect(await paneLines(page, 2)).toEqual(UNIFIED);
  await endDiff(page);
  expect(await layoutNames(page)).toEqual({ count: 2, active: 1, tabs: ['original.txt', 'modified.txt'] });
});

test('比較できるタブが 2 つ未満なら案内し、同じペインの重複・空のペインは指定できない', async ({ page }) => {
  await page.getByRole('menuitem', { name: '表示' }).click();
  await page.getByRole('menuitem', { name: '差分比較…' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('2 つのファイルを開いてください');

  await addTabs(page, [
    ['a.txt', ORIGINAL],
    ['b.txt', MODIFIED],
  ]);
  await arrange(page, 4, ['a.txt', 'b.txt', null, null]);
  await openDiffDialog(page);
  const d = dialog(page);
  const [a, b, result] = ['比較元（変更前）のペイン', '比較先（変更後）のペイン', '差分結果を表示するペイン'].map((l) => d.getByLabel(l));
  // 同じペインを複数の役割に指定できない
  await b.selectOption('0');
  await d.getByRole('button', { name: '比較する' }).click();
  await expect(d.getByRole('alert')).toContainText('それぞれ別のペイン');
  await b.selectOption('1');
  await result.selectOption('1');
  await d.getByRole('button', { name: '比較する' }).click();
  await expect(d.getByRole('alert')).toContainText('それぞれ別のペイン');
  // 比較先が空のペインなら、タブが必要であることを案内する
  await result.selectOption('2');
  await b.selectOption('3');
  await d.getByRole('button', { name: '比較する' }).click();
  await expect(d.getByRole('alert')).toContainText('比較先（ペイン 4）にはタブが表示されていません');
  await a.selectOption('2');
  await b.selectOption('1');
  await result.selectOption('3');
  await d.getByRole('button', { name: '比較する' }).click();
  await expect(d.getByRole('alert')).toContainText('比較元（ペイン 3）にはタブが表示されていません');
  await expect(bar(page)).toBeHidden();
  await d.getByRole('button', { name: 'キャンセル' }).click();
  expect(await layoutNames(page)).toEqual({ count: 4, active: 0, tabs: ['a.txt', 'b.txt', null, null] });
});

test('3・4 ペインで比較元・比較先・結果表示を自由に指定でき、結果表示ペインの元のタブを復元する', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', ORIGINAL],
    ['b.txt', MODIFIED],
    ['c.txt', 'ccc'],
    ['d.txt', 'dddd'],
  ]);
  await arrange(page, 4, ['a.txt', 'b.txt', 'c.txt', 'd.txt'], 2);
  const before = await layoutNames(page);

  // 結果をペイン 1（a.txt を表示中）に出し、ペイン 4 と 2 を比較する
  await openDiffDialog(page);
  await expect(dialog(page)).not.toContainText('ペイン数を'); // 3・4 ペインでは拡張しない
  await dialog(page).getByRole('button', { name: 'キャンセル' }).click();
  await startDiff(page, { a: 3, b: 1, result: 0 });
  expect(await layoutNames(page)).toEqual({ count: 4, active: 3, tabs: [null, 'b.txt', 'c.txt', 'd.txt'] });
  await expect(pane(page, 0).locator('.pane-diff-badge')).toHaveText('差分結果');
  expect((await paneLines(page, 0))[0]).toMatch(/^@@/);
  await expect(pane(page, 3).locator('.pane-diff-badge')).toHaveText('比較元');
  await expect(pane(page, 1).locator('.pane-diff-badge')).toHaveText('比較先');
  // 比較に使わないペイン（c.txt）には差分表示がない
  await expect(pane(page, 2).locator('[class*="cm-diff-"]')).toHaveCount(0);
  await expect(page.locator('.tab', { hasText: 'a.txt' })).toBeVisible();

  await endDiff(page);
  expect(await layoutNames(page)).toEqual(before);
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
  await expect(paneEditor(page, 0)).toContainText('# 設定');
});

test('結果表示ペインに既存タブがあっても、本文と Undo 履歴を保ったまま復元する', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', ORIGINAL],
    ['b.txt', MODIFIED],
    ['c.txt', 'ccc'],
  ]);
  await arrange(page, 3, ['a.txt', 'b.txt', 'c.txt'], 2);
  // 結果表示にするペインのタブを、比較前に編集しておく
  await paneEditor(page, 2).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('-edited');
  expect(await tabText(page, 'c.txt')).toBe('ccc-edited');

  await startDiff(page, { a: 0, b: 1, result: 2 });
  expect(await layoutNames(page)).toMatchObject({ tabs: ['a.txt', 'b.txt', null] });
  expect(await tabText(page, 'c.txt')).toBe('ccc-edited');
  await endDiff(page);
  expect(await layoutNames(page)).toEqual({ count: 3, active: 2, tabs: ['a.txt', 'b.txt', 'c.txt'] });
  await expect(paneEditor(page, 2)).toContainText('ccc-edited');
  await paneEditor(page, 2).click();
  await page.keyboard.press('Control+z');
  expect(await tabText(page, 'c.txt')).toBe('ccc');
  await page.keyboard.press('Control+y');
  expect(await tabText(page, 'c.txt')).toBe('ccc-edited');
});

test('比較前に空だったペイン（アクティブな空ペインを含む）は、終了後も空のまま復元される', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', ORIGINAL],
    ['b.txt', MODIFIED],
  ]);
  await arrange(page, 4, ['a.txt', null, 'b.txt', null], 1);
  const before = await layoutNames(page);
  expect(before).toEqual({ count: 4, active: 1, tabs: ['a.txt', null, 'b.txt', null] });
  // 結果は空のペイン 2 に表示する
  await startDiff(page, { a: 0, b: 2, result: 1 });
  expect(await layoutNames(page)).toMatchObject({ tabs: ['a.txt', null, 'b.txt', null] });
  expect(await paneLines(page, 1)).toEqual(UNIFIED);
  await endDiff(page);
  expect(await layoutNames(page)).toEqual(before);
  await expect(pane(page, 1).locator('.pane-empty')).toBeVisible();
  await expect(pane(page, 3).locator('.pane-empty')).toBeVisible();
});

test('結果は Git 風の差分で表示し、行番号・色分け・「差分はありません」を確認できる', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', ORIGINAL],
    ['b.txt', MODIFIED],
    ['same.txt', ORIGINAL],
    ['empty.txt', ''],
    ['jp-a.txt', 'こんにちは世界\nさようなら'],
    ['jp-b.txt', 'こんばんは世界\nさようなら'],
  ]);
  await arrange(page, 3, ['a.txt', 'b.txt', null]);
  await startDiff(page);
  const result = pane(page, 2);
  expect(await paneLines(page, 2)).toEqual(UNIFIED);
  await expect(result.locator('.cm-line.cm-diff-r-del')).toHaveText(['- timeout=30', '- debug=false']);
  await expect(result.locator('.cm-line.cm-diff-r-add')).toHaveText(['+ timeout=60', '+ debug=true', '+ cache=true']);
  await expect(result.locator('.cm-line.cm-diff-hunk')).toHaveText(['@@ -2,1 +2,1 @@', '@@ -4,1 +4,2 @@']);
  // 比較元・比較先の行番号
  await expect(result.locator('.cm-diff-gutter-oldNo')).toContainText('2');
  await expect(result.locator('.cm-diff-gutter-oldNo')).toContainText('4');
  await expect(result.locator('.cm-diff-gutter-newNo')).toContainText('5');
  // 変更前・変更後の行内の異なる文字
  await expect(result.locator('.cm-diff-text-del').first()).toHaveText('3');
  await expect(result.locator('.cm-diff-text-add').first()).toHaveText('6');
  // 背景色は、追加・削除・見出しで異なる
  const bg = (sel: string) => result.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const colors = new Set([await bg('.cm-diff-r-del'), await bg('.cm-diff-r-add'), await bg('.cm-diff-hunk')]);
  expect(colors.size).toBe(3);

  // 同一内容 → 差分はありません
  await arrange(page, 3, ['a.txt', 'same.txt', null]);
  await expect(bar(page)).toBeHidden(); // 配置の変更で比較は終了
  await startDiff(page);
  expect(await paneLines(page, 2)).toEqual(['差分はありません']);
  await expect(bar(page).locator('.diff-summary')).toContainText('差分はありません');
  await expect(bar(page).getByRole('button', { name: /次の差分/ })).toBeDisabled();
  await endDiff(page);

  // 空文書・日本語
  await arrange(page, 3, ['empty.txt', 'a.txt', null]);
  await startDiff(page);
  expect((await paneLines(page, 2))[0]).toBe('@@ -0,0 +1,5 @@');
  await endDiff(page);
  await arrange(page, 3, ['jp-a.txt', 'jp-b.txt', null]);
  await startDiff(page);
  expect(await paneLines(page, 2)).toEqual(['@@ -1,1 +1,1 @@', '- こんにちは世界', '+ こんばんは世界']);
});

test('結果表示は読み取り専用で、入力しても変わらない', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', ORIGINAL],
    ['b.txt', MODIFIED],
  ]);
  await arrange(page, 3, ['a.txt', 'b.txt', null]);
  await startDiff(page);
  const before = await paneLines(page, 2);
  await paneEditor(page, 2).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('書けない');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  expect(await paneLines(page, 2)).toEqual(before);
  expect(await tabText(page, 'a.txt')).toBe(ORIGINAL);
  expect(await tabText(page, 'b.txt')).toBe(MODIFIED);
});

function numberedLines(n: number, edits: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1} 行の内容`).join('\n');
}

test('前の差分・次の差分（F8・Shift+F8）と結果のクリックで、比較元・比較先の対応位置を表示する', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', numberedLines(400, { 40: 'A40', 200: 'A200', 390: 'A390' })],
    ['b.txt', numberedLines(400, { 40: 'B40', 200: 'B200', 390: 'B390' })],
  ]);
  await arrange(page, 3, ['a.txt', 'b.txt', null]);
  await startDiff(page);
  await expect(bar(page).locator('.diff-summary')).toContainText('差分 3 件');
  await expect(bar(page).locator('.diff-position')).toHaveText('1 / 3');

  const visibleCurrent = (i: number) =>
    pane(page, i).evaluate((el) => {
      const sc = el.querySelector('.cm-scroller')!.getBoundingClientRect();
      const lines = Array.from(el.querySelectorAll<HTMLElement>('.cm-line.cm-diff-current'));
      const inView = lines.filter((l) => {
        const r = l.getBoundingClientRect();
        return r.top >= sc.top - 1 && r.bottom <= sc.bottom + 1;
      });
      return inView.map((l) => l.textContent);
    });

  await expect.poll(() => visibleCurrent(0)).toEqual(['A40']);
  await expect.poll(() => visibleCurrent(1)).toEqual(['B40']);
  await expect.poll(() => visibleCurrent(2)).toEqual(['@@ -40,1 +40,1 @@', '- A40', '+ B40']);

  await bar(page).getByRole('button', { name: /次の差分/ }).click();
  await expect(bar(page).locator('.diff-position')).toHaveText('2 / 3');
  await expect.poll(() => visibleCurrent(0)).toEqual(['A200']);
  await expect.poll(() => visibleCurrent(1)).toEqual(['B200']);
  await page.keyboard.press('F8');
  await expect(bar(page).locator('.diff-position')).toHaveText('3 / 3');
  await expect.poll(() => visibleCurrent(0)).toEqual(['A390']);
  await page.keyboard.press('F8');
  await expect(bar(page).locator('.diff-position')).toHaveText('1 / 3');
  await page.keyboard.press('Shift+F8');
  await expect(bar(page).locator('.diff-position')).toHaveText('3 / 3');
  await bar(page).getByRole('button', { name: /前の差分/ }).click();
  await expect(bar(page).locator('.diff-position')).toHaveText('2 / 3');

  // 結果の差分（行）をクリックすると、その差分を選択し、比較元・比較先の対応位置を表示する
  await pane(page, 2).locator('.cm-line', { hasText: '- A390' }).click();
  await expect(bar(page).locator('.diff-position')).toHaveText('3 / 3');
  await expect.poll(() => visibleCurrent(0)).toEqual(['A390']);
  await expect.poll(() => visibleCurrent(1)).toEqual(['B390']);
  await pane(page, 2).locator('.cm-line', { hasText: '+ B40' }).click();
  await expect(bar(page).locator('.diff-position')).toHaveText('1 / 3');
  await expect.poll(() => visibleCurrent(0)).toEqual(['A40']);
  // 行番号のガターのクリックでも選択できる
  await pane(page, 2).locator('.cm-diff-gutter-newNo .cm-gutterElement', { hasText: '200' }).click();
  await expect(bar(page).locator('.diff-position')).toHaveText('2 / 3');
});

test('比較中の編集で結果が更新され、Undo/Redo と終了後の編集もできる', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', ORIGINAL],
    ['b.txt', MODIFIED],
  ]);
  await arrange(page, 3, ['a.txt', 'b.txt', null]);
  await startDiff(page);
  expect(await paneLines(page, 2)).toEqual(UNIFIED);

  // 比較先の末尾に追記する
  await paneEditor(page, 1).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nextra=1');
  expect(await tabText(page, 'b.txt')).toBe(`${MODIFIED}\nextra=1`);
  await expect.poll(() => paneLines(page, 2)).toEqual([...UNIFIED, '', '@@ -5,0 +7,1 @@', '+ extra=1']);
  await expect(bar(page).locator('.diff-summary')).toContainText('差分 3 件');

  // 比較元を編集して、内容を一致させる
  await paneEditor(page, 0).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(`${MODIFIED}\nextra=1`.replace(/\n/g, '\n'));
  await expect.poll(() => paneLines(page, 2)).toEqual(['差分はありません']);
  await expect(bar(page).locator('.diff-summary')).toContainText('差分はありません');

  // Undo で差分が戻る
  await page.keyboard.press('Control+z');
  await expect(bar(page).locator('.diff-summary')).toContainText('差分');
  await page.keyboard.press('Control+y');
  await expect(bar(page).locator('.diff-summary')).toContainText('差分はありません');

  await endDiff(page);
  expect(await tabText(page, 'b.txt')).toBe(`${MODIFIED}\nextra=1`);
  expect(await tabText(page, 'a.txt')).toBe(`${MODIFIED}\nextra=1`);
  // 終了後も通常どおり編集でき、Undo 履歴が残っている
  expect(await layoutNames(page)).toEqual({ count: 3, active: 0, tabs: ['a.txt', 'b.txt', null] });
  await paneEditor(page, 0).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('!');
  await page.keyboard.press('Control+z');
  expect(await tabText(page, 'a.txt')).toBe(`${MODIFIED}\nextra=1`);
  await page.keyboard.press('Control+z');
  expect(await tabText(page, 'a.txt')).not.toBe(`${MODIFIED}\nextra=1`);
});

test('比較中のタブを閉じる・ペインの表示を変える・バックアップを復元すると、安全に終了する', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', ORIGINAL],
    ['b.txt', MODIFIED],
    ['c.txt', 'ccc'],
  ]);
  // タブを閉じる（結果表示のために外していた c.txt は元のペインに戻る）
  await arrange(page, 3, ['a.txt', 'b.txt', 'c.txt']);
  await startDiff(page, { a: 0, b: 1, result: 2 });
  await page.locator('.tab', { hasText: 'b.txt' }).locator('.tab-close').click();
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('.toast')).toContainText('比較中のタブが閉じられたため、差分比較を終了しました');
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
  const afterClose = await layoutNames(page);
  expect(afterClose.tabs.filter((t) => t === 'c.txt')).toHaveLength(1);
  expect(await tabText(page, 'c.txt')).toBe('ccc');
  expect(await tabText(page, 'a.txt')).toBe(ORIGINAL);

  // 比較元のペインに別のタブを表示する
  await addTabs(page, [['b2.txt', MODIFIED]]);
  await arrange(page, 3, ['a.txt', 'b2.txt', null]);
  await startDiff(page, { a: 0, b: 1, result: 2 });
  await page.locator('.tab', { hasText: 'c.txt' }).click();
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('.toast').last()).toContainText('差分比較を終了しました');
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
  expect(await tabText(page, 'a.txt')).toBe(ORIGINAL);

  // バックアップを復元する
  await arrange(page, 3, ['a.txt', 'b2.txt', null]);
  await page.getByRole('menuitem', { name: 'ファイル' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /バックアップを書き出し/ }).click();
  const json = await readFile((await (await download).path())!, 'utf8');
  await startDiff(page, { a: 0, b: 1, result: 2 });
  await page.getByRole('menuitem', { name: 'ファイル' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'バックアップから復元…' }).click();
  await (await chooser).setFiles([{ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(json) }]);
  await dialog(page).getByRole('button', { name: '置き換える' }).click();
  await dialog(page).getByRole('button', { name: '上書きする' }).click();
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
  expect(await tabText(page, 'a.txt')).toBe(ORIGINAL);
  expect(await tabText(page, 'b2.txt')).toBe(MODIFIED);
  // 復元後に、もう一度比較できる
  await arrange(page, 3, ['a.txt', 'b2.txt', null]);
  await startDiff(page, { a: 0, b: 1, result: 2 });
  await expect(bar(page).locator('.diff-summary')).toContainText('差分 2 件');
});

test('結果表示は保存・バックアップ・再読み込みに混入せず、比較は再読み込み後に解除される', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', ORIGINAL],
    ['b.txt', MODIFIED],
    ['c.txt', 'ccc'],
  ]);
  await arrange(page, 3, ['a.txt', 'b.txt', 'c.txt']);
  await startDiff(page, { a: 0, b: 1, result: 2 });
  await paneEditor(page, 1).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('?');
  await saveNow(page);

  const stored = await page.evaluate(() => Object.entries(localStorage).map(([k, v]) => `${k}=${v}`).join('\n'));
  expect(stored).not.toContain('@@ -2,1');
  expect(stored).not.toMatch(/差分結果|diff/i);

  // バックアップにも混入しない。結果表示のために外したタブは、元のペインの配置で保存される
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'ファイル' }).click();
  await page.getByRole('menuitem', { name: /バックアップを書き出し/ }).click();
  const text = await readFile((await (await downloadPromise).path())!, 'utf8');
  expect(text).not.toContain('@@ -2,1');
  const backup = JSON.parse(text) as { tabs: { name: string }[]; layout: { count: number; panes: (number | null)[] } };
  expect(backup.tabs.map((t) => t.name)).toEqual(['新規 1', 'a.txt', 'b.txt', 'c.txt']);
  expect(backup.layout.panes).toEqual([1, 2, 3]);

  await page.reload();
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
  await expect(page.locator('.pane-diff-badge:visible')).toHaveCount(0);
  expect(await layoutNames(page)).toMatchObject({ count: 3, tabs: ['a.txt', 'b.txt', 'c.txt'] });
  expect(await tabText(page, 'b.txt')).toBe(`${MODIFIED}?`);
  expect(await tabText(page, 'c.txt')).toBe('ccc');
  await expect(page.locator('.tab')).toHaveCount(4);
  // 通常のエディタとして使える
  await expect(paneEditor(page, 2)).toContainText('ccc');
});

test('ライト・ダークの両方で、削除・追加・見出しが背景色で区別できる', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', ORIGINAL],
    ['b.txt', MODIFIED],
  ]);
  await arrange(page, 3, ['a.txt', 'b.txt', null]);
  await startDiff(page);
  const colors = () =>
    pane(page, 2).evaluate((el) => {
      const bg = (sel: string) => getComputedStyle(el.querySelector(sel)!).backgroundColor;
      return { del: bg('.cm-diff-r-del'), add: bg('.cm-diff-r-add'), hunk: bg('.cm-diff-hunk') };
    });
  const alpha = (c: string) => (c.startsWith('rgba') ? Number(c.split(',')[3].replace(')', '')) : c.includes('/') ? Number(c.split('/')[1].replace(')', '')) : 1);
  const seen: string[] = [];
  for (const theme of ['ライトテーマ', 'ダークテーマ']) {
    await page.getByRole('menuitem', { name: '表示' }).click();
    await page.getByRole('menuitemcheckbox', { name: theme }).click();
    const c = await colors();
    seen.push(c.del);
    expect(new Set([c.del, c.add, c.hunk]).size).toBe(3);
    for (const v of Object.values(c)) {
      expect(v).not.toBe('rgba(0, 0, 0, 0)');
      expect(alpha(v)).toBeLessThan(0.5);
    }
    // テーマを切り替えても、結果表示は維持される
    expect(await paneLines(page, 2)).toEqual(UNIFIED);
  }
  expect(new Set(seen).size).toBe(2);
});

test('日本語を含む大きめのファイルでも、比較中の入力が重くならない', async ({ page }) => {
  const lines = Array.from({ length: 20000 }, (_, i) => `第${i}行：日本語を含むテキストの行です。value=${i * 3}`);
  const edited = [...lines];
  edited[10] = '第10行：変更された行です。';
  edited.splice(15000, 3);
  edited.splice(5000, 0, '挿入された行');
  await addTabs(page, [
    ['big-a.txt', lines.join('\n')],
    ['big-b.txt', edited.join('\n')],
  ]);
  await arrange(page, 3, ['big-a.txt', 'big-b.txt', null]);
  await startDiff(page);
  await expect(bar(page).locator('.diff-summary')).toHaveText('差分 3 件（追加 1・削除 1・変更 1）', { timeout: 10_000 });
  await expect(pane(page, 2).locator('.cm-diff-hunk').first()).toHaveText('@@ -11,1 +11,1 @@');

  await paneEditor(page, 1).click();
  await page.keyboard.press('Control+Home');
  const started = Date.now();
  await page.keyboard.type('日本語のテスト入力です。あいうえお', { delay: 0 });
  expect(Date.now() - started).toBeLessThan(5000);
  expect((await tabText(page, 'big-b.txt')).startsWith('日本語のテスト入力です。あいうえお第0行')).toBe(true);
  // 入力が落ち着いたら、結果が更新される
  await expect.poll(() => paneLines(page, 2).then((l) => l[0]), { timeout: 10_000 }).toBe('@@ -1,1 +1,1 @@');
});
