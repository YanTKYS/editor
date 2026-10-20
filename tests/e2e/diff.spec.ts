import { expect, test, type Page } from '@playwright/test';
import { openApp, saveNow } from './helpers';

const pane = (page: Page, i: number) => page.locator(`.pane[data-pane="${i}"]`);
const paneEditor = (page: Page, i: number) => pane(page, i).locator('.cm-content');
const visiblePanes = (page: Page) => page.locator('.pane:not([hidden])');
const bar = (page: Page) => page.locator('.diff-bar');

interface AppHandle {
  addTab(init: { name: string }, content: string): { id: string };
  activateTab(id: string): void;
  layout: { count: number; active: number; tabs: (string | null)[] };
  store: { all: { id: string; name: string }[] };
  editor: { getContent(id: string): string };
  diff: { active: boolean };
}

/** 名前付きのタブを作成する（既存の空タブはそのまま残す） */
async function addTabs(page: Page, tabs: [string, string][]): Promise<void> {
  await page.evaluate((tabs) => {
    const app = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    for (const [name, content] of tabs) app.activateTab(app.addTab({ name }, content).id);
  }, tabs);
}

async function tabText(page: Page, name: string): Promise<string> {
  return page.evaluate((name) => {
    const app = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    const tab = app.store.all.find((t) => t.name === name);
    return tab ? app.editor.getContent(tab.id) : '';
  }, name);
}

async function layoutNames(page: Page) {
  return page.evaluate(() => {
    const app = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    const name = (id: string | null) => (id ? (app.store.all.find((t) => t.id === id)?.name ?? '?') : null);
    return { count: app.layout.count, active: app.layout.active, tabs: app.layout.tabs.map(name) };
  });
}

async function openDiffDialog(page: Page): Promise<void> {
  await page.getByRole('menuitem', { name: '表示' }).click();
  await page.getByRole('menuitem', { name: '差分比較…' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function startDiff(
  page: Page,
  a: string,
  b: string,
  panes?: { paneA: number; paneB: number },
): Promise<void> {
  await openDiffDialog(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('比較元（左）のタブ').selectOption({ label: a });
  await dialog.getByLabel('比較先（右）のタブ').selectOption({ label: b });
  if (panes) {
    await dialog.getByLabel('比較元を表示するペイン').selectOption(String(panes.paneA));
    await dialog.getByLabel('比較先を表示するペイン').selectOption(String(panes.paneB));
  }
  await dialog.getByRole('button', { name: '比較する' }).click();
  await expect(bar(page)).toBeVisible();
}

const SAMPLE_A = 'alpha\nbeta\ngamma\ndelta\nepsilon';
const SAMPLE_B = 'alpha\nbeta changed\ngamma\nepsilon\nzeta';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('表示メニューから、1 画面を自動で 2 分割して比較を開始・終了できる', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', SAMPLE_A],
    ['b.txt', SAMPLE_B],
  ]);
  await page.locator('.tab', { hasText: 'a.txt' }).click();
  expect(await layoutNames(page)).toEqual({ count: 1, active: 0, tabs: ['a.txt'] });
  const tabCount = await page.locator('.tab').count();

  await startDiff(page, 'a.txt', 'b.txt');
  await expect(visiblePanes(page)).toHaveCount(2);
  expect(await layoutNames(page)).toEqual({ count: 2, active: 0, tabs: ['a.txt', 'b.txt'] });
  // タブは複製されない
  await expect(page.locator('.tab')).toHaveCount(tabCount);
  await expect(pane(page, 0).locator('.pane-diff-badge')).toHaveText('比較元');
  await expect(pane(page, 1).locator('.pane-diff-badge')).toHaveText('比較先');

  // 変更（beta）・削除（delta）・追加（zeta）を件数表示し、色分けする
  await expect(bar(page).locator('.diff-summary')).toHaveText('差分 3 件（追加 1・削除 1・変更 1）');
  await expect(pane(page, 0).locator('.cm-line.cm-diff-chg')).toHaveText('beta');
  await expect(pane(page, 1).locator('.cm-line.cm-diff-chg')).toHaveText('beta changed');
  await expect(pane(page, 0).locator('.cm-line.cm-diff-del')).toHaveText('delta');
  await expect(pane(page, 1).locator('.cm-line.cm-diff-add')).toHaveText('zeta');
  // 変更行は行内の異なる文字も強調する
  await expect(pane(page, 1).locator('.cm-diff-text-add')).toHaveText(' changed');
  // 比較先にだけ行がある位置・比較元にだけ行がある位置を境界線で示す
  await expect(pane(page, 1).locator('.cm-line.cm-diff-gap-before')).toHaveText('epsilon');

  await bar(page).getByRole('button', { name: '比較終了' }).click();
  await expect(bar(page)).toBeHidden();
  await expect(visiblePanes(page)).toHaveCount(1);
  expect(await layoutNames(page)).toEqual({ count: 1, active: 0, tabs: ['a.txt'] });
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
  await expect(page.locator('.pane-diff-badge:visible')).toHaveCount(0);
  // 本文はそのまま、通常の編集ができる
  await pane(page, 0).locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('!');
  expect(await tabText(page, 'a.txt')).toBe(`${SAMPLE_A}!`);
  expect(await tabText(page, 'b.txt')).toBe(SAMPLE_B);
});

test('同じタブ同士は比較できず、タブが 1 つだけなら案内する', async ({ page }) => {
  await page.getByRole('menuitem', { name: '表示' }).click();
  await page.getByRole('menuitem', { name: '差分比較…' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('2 つ以上のタブ');

  await addTabs(page, [['a.txt', SAMPLE_A]]);
  await openDiffDialog(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('比較元（左）のタブ').selectOption({ label: 'a.txt' });
  await dialog.getByLabel('比較先（右）のタブ').selectOption({ label: 'a.txt' });
  await dialog.getByRole('button', { name: '比較する' }).click();
  await expect(dialog.getByRole('alert')).toContainText('同じタブ同士は比較できません');
  await expect(bar(page)).toBeHidden();
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await expect(visiblePanes(page)).toHaveCount(1);
});

test('内容が同じ場合は「差分はありません」と表示する', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', SAMPLE_A],
    ['b.txt', SAMPLE_A],
  ]);
  await startDiff(page, 'a.txt', 'b.txt');
  await expect(bar(page).locator('.diff-summary')).toContainText('差分はありません');
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
  await expect(bar(page).getByRole('button', { name: /次の差分/ })).toBeDisabled();
});

test('2 分割では左右のペインで比較する', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', SAMPLE_A],
    ['b.txt', SAMPLE_B],
  ]);
  await page.locator('.split-button[data-split="2"]').click();
  const before = await layoutNames(page);
  await startDiff(page, 'a.txt', 'b.txt');
  expect(await layoutNames(page)).toMatchObject({ count: 2, tabs: ['a.txt', 'b.txt'] });
  // 2 分割ではペインの選択肢は出ない
  await openDiffDialog(page);
  await expect(page.getByRole('dialog').getByLabel('比較元を表示するペイン')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click();
  await bar(page).getByRole('button', { name: '比較終了' }).click();
  expect(await layoutNames(page)).toEqual(before);
});

test('3・4 分割では比較する 2 つのペインを指定でき、他のペインは維持される', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', SAMPLE_A],
    ['b.txt', SAMPLE_B],
    ['c.txt', 'cccc'],
    ['d.txt', 'dddd'],
  ]);
  await page.locator('.tab', { hasText: 'a.txt' }).click();
  await page.locator('.split-button[data-split="4"]').click();
  await expect(visiblePanes(page)).toHaveCount(4);
  const before = await layoutNames(page);
  expect(before.tabs).toEqual(['a.txt', expect.any(String), expect.any(String), expect.any(String)]);

  await startDiff(page, 'a.txt', 'b.txt', { paneA: 2, paneB: 3 });
  const during = await layoutNames(page);
  expect(during).toMatchObject({ count: 4, active: 2 });
  expect(during.tabs.slice(2)).toEqual(['a.txt', 'b.txt']);
  await expect(pane(page, 2).locator('.cm-diff-chg')).toHaveText('beta');
  await expect(pane(page, 3).locator('.cm-diff-chg')).toHaveText('beta changed');
  // 比較に使わないペインには差分表示がない
  await expect(pane(page, 0).locator('[class*="cm-diff-"]')).toHaveCount(0);
  await expect(pane(page, 1).locator('[class*="cm-diff-"]')).toHaveCount(0);

  await bar(page).getByRole('button', { name: '比較終了' }).click();
  expect(await layoutNames(page)).toEqual(before);
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
});

test('比較前に空だったペイン（アクティブな空ペインを含む）は、比較終了後も空のまま復元される', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', SAMPLE_A],
    ['b.txt', SAMPLE_B],
  ]);
  await page.locator('.split-button[data-split="4"]').click();
  await expect(visiblePanes(page)).toHaveCount(4);
  // 空のペイン 2 とペイン 4 を作り、空のペイン 2 をアクティブにする
  await page.evaluate(() => {
    const app = (window as unknown as { __editorApp: { layout: { show(id: null, pane: number): void; setActive(p: number): void } } }).__editorApp;
    app.layout.show(null, 1);
    app.layout.setActive(1);
  });
  const before = await layoutNames(page);
  expect(before.tabs[1]).toBeNull();
  expect(before.tabs[3]).toBeNull();
  expect(before.active).toBe(1);

  // 空のペインを比較対象にする
  await startDiff(page, 'a.txt', 'b.txt', { paneA: 1, paneB: 3 });
  const during = await layoutNames(page);
  expect(during.tabs[1]).toBe('a.txt');
  expect(during.tabs[3]).toBe('b.txt');
  await expect(pane(page, 3).locator('.cm-diff-chg')).toHaveText('beta changed');

  // 比較中に編集しておく
  await paneEditor(page, 3).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('?');

  await bar(page).getByRole('button', { name: '比較終了' }).click();
  await expect(bar(page)).toBeHidden();
  expect(await layoutNames(page)).toEqual(before);
  await expect(pane(page, 1).locator('.pane-empty')).toBeVisible();
  await expect(pane(page, 3).locator('.pane-empty')).toBeVisible();
  // 比較中の編集は、タブに残っている
  expect(await tabText(page, 'b.txt')).toBe(`${SAMPLE_B}?`);
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
});

function numberedLines(n: number, edits: Record<number, string> = {}, extraTop = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < extraTop; i++) lines.push(`追加行 ${i}`);
  for (let i = 1; i <= n; i++) lines.push(edits[i] ?? `line ${i} 行の内容`);
  return lines.join('\n');
}

/** ペインの画面上端に見えている最初の行のテキスト */
async function firstVisibleLine(page: Page, i: number): Promise<string> {
  return pane(page, i).evaluate((el) => {
    const top = el.querySelector('.cm-scroller')!.getBoundingClientRect().top;
    const lines = Array.from(el.querySelectorAll<HTMLElement>('.cm-line'));
    return lines.find((l) => l.getBoundingClientRect().bottom > top + 2)?.textContent ?? '';
  });
}

test('前の差分・次の差分で移動し、両方のペインで対象の差分が見える', async ({ page }) => {
  const a = numberedLines(400, { 40: 'A40 changed', 200: 'A200 changed', 390: 'A390 changed' });
  const b = numberedLines(400, { 40: 'B40 changed', 200: 'B200 changed', 390: 'B390 changed' });
  await addTabs(page, [
    ['a.txt', a],
    ['b.txt', b],
  ]);
  await startDiff(page, 'a.txt', 'b.txt');
  await expect(bar(page).locator('.diff-summary')).toContainText('差分 3 件');
  await expect(bar(page).locator('.diff-position')).toHaveText('1 / 3');

  const visibleCurrent = async (i: number) =>
    pane(page, i).evaluate((el) => {
      const sc = el.querySelector('.cm-scroller')!.getBoundingClientRect();
      const cur = el.querySelector<HTMLElement>('.cm-line.cm-diff-current');
      if (!cur) return null;
      const r = cur.getBoundingClientRect();
      return r.top >= sc.top && r.bottom <= sc.bottom ? cur.textContent : 'hidden';
    });

  await expect.poll(() => visibleCurrent(0)).toBe('A40 changed');
  await expect.poll(() => visibleCurrent(1)).toBe('B40 changed');

  await bar(page).getByRole('button', { name: /次の差分/ }).click();
  await expect(bar(page).locator('.diff-position')).toHaveText('2 / 3');
  await expect.poll(() => visibleCurrent(0)).toBe('A200 changed');
  await expect.poll(() => visibleCurrent(1)).toBe('B200 changed');

  await page.keyboard.press('F8');
  await expect(bar(page).locator('.diff-position')).toHaveText('3 / 3');
  await expect.poll(() => visibleCurrent(0)).toBe('A390 changed');
  await page.keyboard.press('F8');
  await expect(bar(page).locator('.diff-position')).toHaveText('1 / 3');
  await page.keyboard.press('Shift+F8');
  await expect(bar(page).locator('.diff-position')).toHaveText('3 / 3');
  await bar(page).getByRole('button', { name: /前の差分/ }).click();
  await expect(bar(page).locator('.diff-position')).toHaveText('2 / 3');
  await expect.poll(() => visibleCurrent(1)).toBe('B200 changed');
});

test('左右のペインのスクロールを、対応する行がそろうように同期する', async ({ page }) => {
  // B には先頭に 30 行が追加されている（行番号がずれる）
  await addTabs(page, [
    ['a.txt', numberedLines(600)],
    ['b.txt', numberedLines(600, {}, 30)],
  ]);
  await startDiff(page, 'a.txt', 'b.txt');
  // 最初の差分（先頭の追加）に移動しているので、いったん先頭に戻す
  const scrollPane = (i: number, top: number) =>
    pane(page, i).locator('.cm-scroller').evaluate((el, top) => {
      el.scrollTop = top;
    }, top);

  await scrollPane(0, 0);
  await scrollPane(0, 3000);
  await expect.poll(async () => {
    const left = await firstVisibleLine(page, 0);
    const right = await firstVisibleLine(page, 1);
    return left === right && left.startsWith('line ');
  }).toBe(true);

  // 右側を動かしても左側が追従する
  await scrollPane(1, 6000);
  await expect.poll(async () => {
    const left = await firstVisibleLine(page, 0);
    const right = await firstVisibleLine(page, 1);
    return left === right && left.startsWith('line ');
  }).toBe(true);

  // 比較を終了するとスクロール同期も解除される
  await bar(page).getByRole('button', { name: '比較終了' }).click();
  await page.locator('.split-button[data-split="2"]').click();
  await expect(visiblePanes(page)).toHaveCount(2);
  const rightBefore = await pane(page, 1).locator('.cm-scroller').evaluate((el) => el.scrollTop);
  await scrollPane(0, 100);
  await page.waitForTimeout(300);
  expect(await pane(page, 1).locator('.cm-scroller').evaluate((el) => el.scrollTop)).toBe(rightBefore);
});

test('比較中の編集で差分表示を更新し、Undo/Redo と終了後の編集もできる', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', SAMPLE_A],
    ['b.txt', SAMPLE_B],
  ]);
  await startDiff(page, 'a.txt', 'b.txt');
  await expect(bar(page).locator('.diff-summary')).toContainText('差分 3 件');

  // 比較先（右）の「zeta」の行末に追記する
  await paneEditor(page, 1).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('!!');
  expect(await tabText(page, 'b.txt')).toBe(`${SAMPLE_B}!!`);
  await expect(pane(page, 1).locator('.cm-line.cm-diff-add')).toHaveText('zeta!!');

  // 右側の内容を A に近づけて、差分の件数が減る
  await page.keyboard.press('Control+a');
  await page.keyboard.type(SAMPLE_A);
  await expect(bar(page).locator('.diff-summary')).toHaveText('差分はありません（内容が同じです）');
  expect(await tabText(page, 'b.txt')).toBe(SAMPLE_A);

  // Undo で差分が戻る
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(bar(page).locator('.diff-summary')).toContainText('差分');
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+y');
  expect(await tabText(page, 'b.txt')).toBe(SAMPLE_A);

  await bar(page).getByRole('button', { name: '比較終了' }).click();
  expect(await tabText(page, 'b.txt')).toBe(SAMPLE_A);
  // 終了後も Undo 履歴が残っている
  await page.locator('.tab', { hasText: 'b.txt' }).click();
  await pane(page, 0).locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  expect(await tabText(page, 'b.txt')).not.toBe(SAMPLE_A);
});

test('比較中のタブを閉じたら、比較を安全に終了する', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', SAMPLE_A],
    ['b.txt', SAMPLE_B],
    ['c.txt', 'ccc'],
  ]);
  await startDiff(page, 'a.txt', 'b.txt');
  await page.locator('.tab', { hasText: 'b.txt' }).locator('.tab-close').click();
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('.toast')).toContainText('比較中のタブが閉じられたため、差分比較を終了しました');
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
  expect(await tabText(page, 'a.txt')).toBe(SAMPLE_A);
  // 通常の編集を続けられる
  await pane(page, 0).locator('.cm-content').click();
  await page.keyboard.type('x');
  expect(await tabText(page, 'a.txt')).toContain('x');
});

test('比較中のペインに別のタブを表示したら、比較を終了する', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', SAMPLE_A],
    ['b.txt', SAMPLE_B],
    ['c.txt', 'ccc'],
  ]);
  await startDiff(page, 'a.txt', 'b.txt');
  await page.locator('.tab', { hasText: 'c.txt' }).click();
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('差分比較を終了しました');
});

test('比較の状態は保存・復元の対象外で、本文とタブの保存に影響しない', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', SAMPLE_A],
    ['b.txt', SAMPLE_B],
  ]);
  await startDiff(page, 'a.txt', 'b.txt');
  await paneEditor(page, 1).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('?');
  await saveNow(page);
  const stored = await page.evaluate(() => Object.entries(localStorage).map(([k, v]) => `${k}=${v}`).join('\n'));
  expect(stored).not.toMatch(/diff/i);

  await page.reload();
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
  expect(await tabText(page, 'a.txt')).toBe(SAMPLE_A);
  expect(await tabText(page, 'b.txt')).toBe(`${SAMPLE_B}?`);

  // バックアップに比較の状態は含まれない
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'ファイル' }).click();
  await page.getByRole('menuitem', { name: /バックアップを書き出し/ }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(path, 'utf8');
  expect(text).not.toMatch(/diff/i);
  expect(JSON.parse(text).tabs.map((t: { name: string }) => t.name)).toContain('b.txt');
});

test('比較中にバックアップを復元すると、比較を終了して復元後のタブを通常どおり表示する', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', SAMPLE_A],
    ['b.txt', SAMPLE_B],
  ]);
  await startDiff(page, 'a.txt', 'b.txt');
  await page.getByRole('menuitem', { name: 'ファイル' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /バックアップを書き出し/ }).click();
  const { readFile } = await import('node:fs/promises');
  const json = await readFile((await (await download).path())!, 'utf8');

  await page.getByRole('menuitem', { name: 'ファイル' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'バックアップから復元…' }).click();
  await (await chooser).setFiles([{ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(json) }]);
  await page.getByRole('dialog').getByRole('button', { name: '置き換える' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '上書きする' }).click();

  await expect(bar(page)).toBeHidden();
  await expect(page.locator('[class*="cm-diff-"]')).toHaveCount(0);
  expect(await tabText(page, 'a.txt')).toBe(SAMPLE_A);
  expect(await tabText(page, 'b.txt')).toBe(SAMPLE_B);
  // 復元後に、もう一度比較できる
  await startDiff(page, 'a.txt', 'b.txt');
  await expect(bar(page).locator('.diff-summary')).toContainText('差分 3 件');
});

test('ライト・ダークの両方で、追加・削除・変更が背景色で区別できる', async ({ page }) => {
  await addTabs(page, [
    ['a.txt', SAMPLE_A],
    ['b.txt', SAMPLE_B],
  ]);
  await startDiff(page, 'a.txt', 'b.txt');
  const colors = () =>
    page.evaluate(() => {
      const bg = (sel: string) => getComputedStyle(document.querySelector(sel)!).backgroundColor;
      return { add: bg('.cm-line.cm-diff-add'), del: bg('.cm-line.cm-diff-del'), chg: bg('.cm-line.cm-diff-chg') };
    });
  const alpha = (c: string) => (c.startsWith('rgba') ? Number(c.split(',')[3].replace(')', '')) : c.startsWith('rgb(') && c.includes('/') ? Number(c.split('/')[1].replace(')', '')) : 1);
  for (const theme of ['ライトテーマ', 'ダークテーマ']) {
    await page.getByRole('menuitem', { name: '表示' }).click();
    await page.getByRole('menuitemcheckbox', { name: theme }).click();
    const c = await colors();
    expect(new Set([c.add, c.del, c.chg]).size).toBe(3);
    for (const v of Object.values(c)) {
      expect(v).not.toBe('rgba(0, 0, 0, 0)');
      expect(alpha(v)).toBeLessThan(0.5); // 文字・選択範囲が見える半透明
    }
  }
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
  await startDiff(page, 'big-a.txt', 'big-b.txt');
  await expect(bar(page).locator('.diff-summary')).toHaveText('差分 3 件（追加 1・削除 1・変更 1）', { timeout: 10_000 });

  // 比較先に連続して入力しても、入力が遅れない
  await paneEditor(page, 1).click();
  await page.keyboard.press('Control+Home');
  const started = Date.now();
  await page.keyboard.type('日本語のテスト入力です。あいうえお', { delay: 0 });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(5000);
  expect((await tabText(page, 'big-b.txt')).startsWith('日本語のテスト入力です。あいうえお第0行')).toBe(true);
  // 入力が落ち着いたら差分が更新される
  await expect(bar(page).locator('.diff-summary')).toContainText('差分', { timeout: 10_000 });
  await expect(pane(page, 1).locator('.cm-line.cm-diff-chg').first()).toContainText('日本語のテスト入力です');
});
