import { expect, type Page } from '@playwright/test';

export async function openApp(page: Page, options: { clear?: boolean } = {}): Promise<void> {
  await page.goto('./');
  if (options.clear ?? true) {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  }
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
}

export const editor = (page: Page) => page.locator('.cm-content');

/** エディタの本文（CodeMirror の内部状態から取得） */
export async function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const app = (window as unknown as { __editorApp: { editor: { view: { state: { doc: { toString(): string } } } } } })
      .__editorApp;
    return app.editor.view.state.doc.toString();
  });
}

export async function typeInEditor(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.type(text);
}

export const tabs = (page: Page) => page.locator('.tab');
export const activeTab = (page: Page) => page.locator('.tab.active .tab-label');

/** 自動保存（デバウンス）を待たずに保存する */
export async function saveNow(page: Page): Promise<void> {
  await page.keyboard.press('Control+s');
  await expect(page.locator('.status-save')).toHaveText('自動保存済み');
}
