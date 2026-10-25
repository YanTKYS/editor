import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { TabMeta } from '../../src/core/types';
import { openApp } from './helpers';

interface AppHandle {
  addTab(init: Partial<TabMeta>, content: string): { id: string };
  store: { all: TabMeta[]; rename(id: string, name: string): void };
  editor: {
    getContent(id: string): string;
    applyToTab(id: string, build: () => { changes: { from: number; insert: string }; userEvent?: string }): void;
  };
  layout: {
    load(state: { count: number; tabs: (string | null)[]; active: number }, ids: string[]): void;
    toJSON(): unknown;
  };
  diff: {
    start(targets: { a: number; b: number; result: number }, plan: (string | null)[]): boolean;
    status: { current: number } | null;
  };
  exportDiff(): void;
}

const bar = (page: Page) => page.getByRole('toolbar', { name: '差分比較', exact: true });
const pane = (page: Page, n: number) => page.locator(`.pane[data-pane="${n}"]`);
const inspect = (page: Page) => page.evaluate(() => {
  const a = (window as unknown as { __editorApp: AppHandle }).__editorApp;
  return {
    tabs: a.store.all.map(t => ({ ...t, content: a.editor.getContent(t.id) })),
    layout: a.layout.toJSON(),
    current: a.diff.status?.current,
  };
});

async function seed(page: Page, before = '共通\n変更前\n中間\n削除', after = '共通\n変更後\n中間\n追加') {
  await openApp(page);
  await page.evaluate(([before, after]) => {
    const a = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    const left = a.addTab({ name: '同名.txt', modifiedSinceFile: false, eol: 'CRLF', bom: true }, before);
    const right = a.addTab({ name: '同名.txt', modifiedSinceFile: true, eol: 'CR', encoding: 'Shift_JIS' }, after);
    const hidden = a.addTab({ name: '残す.txt', modifiedSinceFile: false }, '退避中の本文');
    const plan = [left.id, right.id, hidden.id];
    a.layout.load({ count: 3, tabs: plan, active: 0 }, a.store.all.map(t => t.id));
    a.diff.start({ a: 0, b: 1, result: 2 }, plan);
  }, [before, after]);
  await expect(bar(page)).toBeVisible();
}

async function downloadReport(page: Page, viaMenu = false) {
  const event = page.waitForEvent('download');
  if (viaMenu) {
    await page.getByRole('menuitem', { name: '表示', exact: true }).click();
    await page.getByRole('menuitem', { name: '差分を書き出し', exact: true }).click();
  } else {
    const button = bar(page).getByRole('button', { name: '差分を書き出し', exact: true });
    await button.focus();
    await page.keyboard.press('Enter');
  }
  const file = await event;
  expect(file.suggestedFilename()).toMatch(/^diff-\d{8}T\d{9}Z\.txt$/);
  const bytes = await readFile(await file.path());
  expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  expect(text).not.toContain('\r');
  return text;
}

test('全差分を通常テキストで取得し、同名の方向・日時を記録して元の本文・状態・履歴を維持する', async ({ page }) => {
  const external: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol.startsWith('http') && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  const common = Array.from({ length: 1000 }, (_, i) => `共通${i}`).join('\n');
  await seed(page, `変更前\n${common}\n末尾の削除`, `変更後\n${common}\n末尾の追加`);
  await pane(page, 0).locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('!');
  await expect(pane(page, 2).locator('.cm-line').first()).toHaveText('@@ -1,1 +1,1 @@');
  await bar(page).getByRole('button', { name: /次の差分/ }).click();
  const before = await inspect(page);
  const text = await downloadReport(page);
  expect(text).toMatch(/出力日時（UTC）: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/);
  expect(text).toContain('比較元（変更前）: "同名.txt"（ペイン 1・タブ 2）');
  expect(text).toContain('比較先（変更後）: "同名.txt"（ペイン 2・タブ 3）');
  expect(text).toContain('比較方向: 比較元（変更前） → 比較先（変更後）');
  expect(text).toContain('差分 2 件（追加 0・削除 0・変更 2）');
  expect(text).toContain('- !変更前\n+ 変更後');
  expect(text).toContain('@@ -1002,1 +1002,1 @@\n- 末尾の削除\n+ 末尾の追加');
  expect(text).not.toContain('共通500');
  expect(text).toContain('適用可能なパッチ形式は保証しません');
  expect(await inspect(page)).toEqual(before);
  await pane(page, 0).locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  expect((await inspect(page)).tabs[1].content.startsWith('変更前')).toBe(true);
  await page.keyboard.press('Control+y');
  expect((await inspect(page)).tabs[1].content.startsWith('!変更前')).toBe(true);
  await bar(page).getByRole('button', { name: '比較終了', exact: true }).click();
  await expect(pane(page, 2).locator('.cm-content')).toHaveText('退避中の本文');
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('狭い画面でも到達でき、入れ替えた方向・変更した名前でメニューから取得できる', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await seed(page);
  await page.evaluate(() => {
    const a = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    a.store.rename(a.store.all[1].id, '変更前の名前.txt');
    a.store.rename(a.store.all[2].id, '変更後の名前.txt');
  });
  await bar(page).getByRole('button', { name: '比較対象…', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '比較元と比較先を入れ替え', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '比較する', exact: true }).click();
  const box = await bar(page).getByRole('button', { name: '差分を書き出し', exact: true }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  const before = await inspect(page);
  const text = await downloadReport(page, true);
  expect(text).toContain('比較元（変更前）: "変更後の名前.txt"（ペイン 2・タブ 3）');
  expect(text).toContain('比較先（変更後）: "変更前の名前.txt"（ペイン 1・タブ 2）');
  expect(text).toContain('- 変更後\n+ 変更前');
  expect(await inspect(page)).toEqual(before);
});

test('遅延再計算の直前でも、最新の本文で画面と書き出しを揃える', async ({ page }) => {
  await seed(page);
  const event = page.waitForEvent('download');
  await page.evaluate(() => {
    const a = (window as unknown as { __editorApp: AppHandle }).__editorApp;
    a.editor.applyToTab(a.store.all[2].id, () => ({ changes: { from: 0, insert: '直前の編集' }, userEvent: 'input.type' }));
    a.exportDiff(); // 同じイベント内で、デバウンス待ちを確実に作る
  });
  const text = await readFile(await (await event).path(), 'utf8');
  expect(text).toContain('+ 直前の編集共通');
  await expect(pane(page, 2)).toContainText('+ 直前の編集共通');
  const before = await inspect(page);
  await page.waitForTimeout(250); // 古いタイマーの実行後にも結果と本文が変わらない
  expect(await inspect(page)).toEqual(before);
});

for (const content of ['', '同一内容\n']) {
  test(`差分なしも書き出せる（${content ? '同一内容・改行設定の違い' : '空文書'}）`, async ({ page }) => {
    await seed(page, content, content);
    const before = await inspect(page);
    const text = await downloadReport(page);
    expect(text).toContain('差分 0 件（追加 0・削除 0・変更 0）');
    expect(text).toMatch(/\n\n差分はありません\n$/);
    expect(await inspect(page)).toEqual(before);
  });
}

for (const failure of ['URL', 'click'] as const) {
  test(`ダウンロード開始の失敗 (${failure}) でも元の状態・差分ナビゲーションを維持する`, async ({ page }) => {
    await seed(page);
    const before = await inspect(page);
    await page.evaluate(failure => {
      if (failure === 'URL') URL.createObjectURL = () => { throw new Error('テスト用の失敗'); };
      else HTMLAnchorElement.prototype.click = () => { throw new Error('テスト用の失敗'); };
    }, failure);
    await bar(page).getByRole('button', { name: '差分を書き出し', exact: true }).click();
    await expect(page.locator('.toast').last()).toContainText('差分テキストを書き出せませんでした');
    expect(await inspect(page)).toEqual(before);
    await expect(page.locator('a[download]')).toHaveCount(0);
    await bar(page).getByRole('button', { name: /次の差分/ }).click();
    await expect(bar(page).locator('.diff-position')).toHaveText('2 / 2');
    await bar(page).getByRole('button', { name: '比較終了', exact: true }).click();
    await expect(pane(page, 2).locator('.cm-content')).toHaveText('退避中の本文');
  });
}

test('比較終了後は書き出しの入口がなく、古い結果も出力しない', async ({ page }) => {
  await seed(page);
  await bar(page).getByRole('button', { name: '比較終了', exact: true }).click();
  await expect(bar(page)).toBeHidden();
  await page.getByRole('menuitem', { name: '表示', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '差分を書き出し', exact: true })).toHaveCount(0);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.evaluate(() => (window as unknown as { __editorApp: AppHandle }).__editorApp.exportDiff());
  await expect(page.locator('.toast').last()).toContainText('差分比較を開始してから');
  expect(downloads).toBe(0);
});
