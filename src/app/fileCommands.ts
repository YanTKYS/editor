import { createBackup, parseBackup, BackupValidationError, type BackupData } from '../core/backup';
import { createId } from '../core/emitter';
import { modeInfo } from '../core/modes';
import type { SourceEncoding, TabMeta } from '../core/types';
import {
  bytesToLoadedFile,
  downloadBlob,
  downloadText,
  exportFileName,
  formatBytes,
  LARGE_FILE_BYTES,
  pickFiles,
  readTextFile,
  sanitizeFileName,
  type LoadedFile,
} from '../files/fileIO';
import { alertDialog, confirmDialog, promptDialog, showDialog } from '../ui/dialogs';
import { h } from '../ui/dom';
import { APP_VERSION, type App } from './app';

const MIME_BY_MODE: Record<string, string> = {
  markdown: 'text/markdown',
  json: 'application/json',
  javascript: 'text/javascript',
  typescript: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
};

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * ファイルの読み込み・書き出し、バックアップ（JSON）の書き出し・復元。
 * 「ブラウザ内保存（localStorage）」とは別の、PC 上のファイルとのやり取りを扱う。
 */
export class FileCommands {
  constructor(private readonly app: App) {}

  /* ---------- 読み込み ---------- */

  async openWithPicker(encoding: SourceEncoding): Promise<void> {
    const files = await pickFiles({ multiple: true });
    if (files.length) await this.openFiles(files, encoding);
  }

  /** 複数ファイルをタブとして開く */
  async openFiles(files: File[], encoding: SourceEncoding): Promise<void> {
    const large = files.filter((f) => f.size > LARGE_FILE_BYTES);
    if (large.length) {
      const ok = await confirmDialog(
        '大きなファイル',
        `${large.map((f) => `${f.name}（${formatBytes(f.size)}）`).join('、')} は大きなファイルです。\n開くことはできますが、ブラウザ内保存の容量（目安 5MB 程度）を超えて保存に失敗する場合があります。開きますか？`,
        '開く',
      );
      if (!ok) return;
    }
    let lastId: string | null = null;
    const replaceId =
      this.app.store.activeTabId && this.app.isPristine(this.app.store.activeTabId)
        ? this.app.store.activeTabId
        : null;
    let opened = 0;
    for (const file of files) {
      const loaded = await this.readWithFallback(file, encoding);
      if (!loaded) continue;
      lastId = this.openLoaded(loaded).id;
      opened++;
    }
    if (lastId) {
      this.app.activateTab(lastId, true);
      if (replaceId && replaceId !== lastId) void this.app.closeTab(replaceId, { confirm: false });
    }
    if (opened > 1) this.app.notifications.toast(`${opened} 個のファイルを開きました。`, 'success');
  }

  private async readWithFallback(file: File, encoding: SourceEncoding): Promise<LoadedFile | null> {
    const result = await readTextFile(file, encoding);
    if (result.ok) return result.file;
    if (result.reason !== 'encoding' || !result.bytes) {
      this.app.notifications.toast(result.message, 'error', 6000);
      return null;
    }
    const other: SourceEncoding = encoding === 'UTF-8' ? 'Shift_JIS' : 'UTF-8';
    const choice = await showDialog<'cancel' | 'other' | 'lossy'>({
      title: '文字コードの確認',
      message: `「${file.name}」は ${encoding} として正しく読み込めない文字を含んでいます。\n${other} として読み込みますか？`,
      cancelValue: 'cancel',
      buttons: [
        { label: '開かない', value: 'cancel' },
        { label: `${encoding} のまま開く（不正な文字は置換）`, value: 'lossy' },
        { label: `${other} として開く`, value: 'other', primary: true },
      ],
    });
    if (choice === 'cancel') return null;
    const retry =
      choice === 'other'
        ? bytesToLoadedFile(file.name, result.bytes, other, false)
        : bytesToLoadedFile(file.name, result.bytes, encoding, false);
    if (retry.ok) return retry.file;
    this.app.notifications.toast(retry.message, 'error', 6000);
    return null;
  }

  private openLoaded(file: LoadedFile): TabMeta {
    const tab = this.app.addTab(
      {
        name: file.name,
        eol: file.eol,
        encoding: file.encoding,
        bom: file.bom,
        modifiedSinceFile: false,
      },
      file.content,
    );
    if (file.mixedEol) {
      this.app.mixedEol.add(tab.id);
      this.app.notifications.toast(
        `「${file.name}」は改行コードが混在しています。書き出し時は ${file.eol} に統一されます。`,
        'warning',
        6000,
      );
    }
    if (file.encoding === 'Shift_JIS') {
      this.app.notifications.toast(
        `「${file.name}」を Shift_JIS として読み込みました。書き出しは UTF-8 で行います。`,
        'info',
        5000,
      );
    }
    return tab;
  }

  /* ---------- 書き出し ---------- */

  /** アクティブタブを書き出す（askName = true ならファイル名を指定） */
  async exportActive(askName: boolean): Promise<void> {
    const tab = this.app.store.active;
    if (!tab) return;
    let name = exportFileName(tab.name, tab.mode);
    if (askName) {
      const input = await promptDialog('名前を付けて書き出し', 'ファイル名', name, {
        okLabel: '書き出し',
        selectBaseName: true,
        validate: (v) => (v.trim() ? null : 'ファイル名を入力してください。'),
      });
      if (input === null) return;
      name = sanitizeFileName(input.trim());
      if (name !== tab.name) this.app.applyRename(tab.id, name);
    }
    this.exportTab(tab.id, name);
  }

  /** タブを UTF-8 のファイルとしてダウンロードさせる */
  exportTab(id: string, name: string): void {
    const tab = this.app.store.get(id);
    if (!tab) return;
    const fileName = exportFileName(name, tab.mode);
    const content = this.app.editor.getContent(id);
    downloadText(content, fileName, tab.eol, tab.bom, MIME_BY_MODE[tab.mode] ?? 'text/plain');
    const wasSjis = tab.encoding === 'Shift_JIS';
    this.app.store.update(id, { modifiedSinceFile: false, encoding: 'UTF-8' });
    this.app.mixedEol.delete(id);
    this.app.scheduleStatusUpdate();
    this.app.notifications.toast(
      `「${fileName}」を書き出しました（UTF-8${tab.bom ? ' BOM 付き' : ''}・${tab.eol}）。${wasSjis ? ' ※Shift_JIS ではなく UTF-8 で保存されています。' : ''}`,
      'success',
      wasSjis ? 6000 : 3000,
    );
  }

  /* ---------- バックアップ ---------- */

  exportBackup(): void {
    const { store, editor, settings } = this.app;
    const tabs = store.all.map((t) => ({
      name: t.name,
      content: editor.getContent(t.id),
      mode: t.mode,
      eol: t.eol,
      encoding: t.encoding,
      bom: t.bom,
    }));
    const activeIndex = Math.max(0, store.activeTabId ? store.indexOf(store.activeTabId) : 0);
    const data = createBackup(tabs, activeIndex, settings, APP_VERSION);
    const json = JSON.stringify(data, null, 2);
    downloadBlob(new Blob([json], { type: 'application/json' }), `editor-backup-${timestamp()}.json`);
    this.app.notifications.toast(`${tabs.length} 個のタブと設定をバックアップとして書き出しました。`, 'success');
  }

  async importBackup(): Promise<void> {
    const [file] = await pickFiles({ multiple: false, accept: '.json,application/json' });
    if (!file) return;
    let data: BackupData;
    try {
      data = parseBackup(await file.text());
    } catch (e) {
      const message = e instanceof BackupValidationError ? e.message : String(e);
      await alertDialog('バックアップを読み込めません', `「${file.name}」は復元できません。\n${message}`);
      return;
    }
    const exported = data.exportedAt ? new Date(data.exportedAt).toLocaleString('ja-JP') : '不明';
    const list = h(
      'ul',
      { class: 'dialog-list' },
      data.tabs.slice(0, 10).map((t) => h('li', { text: `${t.name}（${t.content.length.toLocaleString()} 文字・${modeInfo(t.mode).label}）` })),
    );
    if (data.tabs.length > 10) list.append(h('li', { text: `ほか ${data.tabs.length - 10} 個` }));
    const choice = await showDialog<'cancel' | 'append' | 'replace'>({
      title: 'バックアップから復元',
      message: h('div', {}, [
        h('p', { text: `作成日時: ${exported}／タブ数: ${data.tabs.length}` }),
        list,
        h('p', {
          text: `「置き換える」を選ぶと、現在の ${this.app.store.count} 個のタブと設定は削除され、バックアップの内容に置き換わります（元に戻せません）。`,
          class: 'dialog-warning',
        }),
      ]),
      cancelValue: 'cancel',
      buttons: [
        { label: 'キャンセル', value: 'cancel' },
        { label: 'タブとして追加', value: 'append' },
        { label: '置き換える', value: 'replace', danger: true },
      ],
    });
    if (choice === 'cancel') return;
    if (choice === 'replace') {
      const ok = await confirmDialog(
        '上書きの確認',
        `現在のタブ ${this.app.store.count} 個と設定を、バックアップの内容で上書きします。よろしいですか？`,
        '上書きする',
        { danger: true },
      );
      if (!ok) return;
      this.replaceWithBackup(data);
    } else {
      let lastId: string | null = null;
      for (const t of data.tabs) {
        lastId = this.app.addTab({ ...t, modifiedSinceFile: true }, t.content).id;
      }
      if (lastId) this.app.activateTab(lastId, true);
      this.app.notifications.toast(`${data.tabs.length} 個のタブを追加しました。`, 'success');
    }
  }

  private replaceWithBackup(data: BackupData): void {
    const { app } = this;
    const oldIds = app.store.all.map((t) => t.id);
    for (const id of oldIds) app.persistence.markTabRemoved(id);
    app.editor.clear();
    app.mixedEol.clear();
    const metas: TabMeta[] = [];
    const now = Date.now();
    for (const t of data.tabs) {
      const id = createId();
      app.editor.addTab(id, t.mode, t.eol, t.content);
      metas.push({
        id,
        name: t.name,
        mode: t.mode,
        eol: t.eol,
        encoding: t.encoding,
        bom: t.bom,
        modifiedSinceFile: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    app.updateSettings(data.settings);
    app.store.reset(metas, metas[data.activeIndex]?.id ?? metas[0].id);
    app.persistence.markAllDirty(metas.map((m) => m.id));
    app.editor.focus();
    app.notifications.toast(`バックアップから ${metas.length} 個のタブを復元しました。`, 'success');
  }

  /* ---------- 保存領域 ---------- */

  async showStorageInfo(): Promise<void> {
    const { app } = this;
    const status = app.persistence.status;
    const statusText: Record<string, string> = {
      saved: '保存済み',
      pending: '保存待ち',
      error: '保存失敗',
      conflict: '停止中（別のタブとの競合）',
      blocked: '停止中（保存データを読み込めません）',
      unavailable: '利用不可',
    };
    const rows: [string, string][] = [
      ['保存先', 'このブラウザの localStorage（PC 上のファイルとは別）'],
      ['状態', statusText[status.kind] ?? status.kind],
      ['タブ数', `${app.store.count}`],
    ];
    if (app.backend) {
      const u = await app.backend.usage();
      const pct = u.quotaChars ? Math.round((u.totalChars / u.quotaChars) * 100) : null;
      rows.push(['このエディタの使用量', `約 ${(u.appChars / 10000).toFixed(1)} 万文字`]);
      rows.push([
        'サイト全体の使用量',
        `約 ${(u.totalChars / 10000).toFixed(1)} 万文字${pct !== null ? `（上限の目安の約 ${pct}%）` : ''}`,
      ]);
    }
    const table = h(
      'table',
      { class: 'info-table' },
      rows.map(([k, v]) => h('tr', {}, [h('th', { text: k }), h('td', { text: v })])),
    );
    const note = h('p', {
      class: 'dialog-note',
      text: '上限はブラウザにより異なります（一般に 500 万文字程度）。同じサイト（例: ○○.github.io）上の他のアプリと容量を共有します。',
    });
    const choice = await showDialog<'close' | 'save' | 'backup' | 'clear'>({
      title: 'ブラウザ内保存',
      body: h('div', {}, [table, note]),
      cancelValue: 'close',
      buttons: [
        { label: 'ブラウザ内データを消去…', value: 'clear', danger: true },
        { label: 'バックアップを書き出す', value: 'backup' },
        { label: '今すぐ保存', value: 'save' },
        { label: '閉じる', value: 'close', primary: true },
      ],
    });
    if (choice === 'save') await app.saveToBrowser();
    else if (choice === 'backup') this.exportBackup();
    else if (choice === 'clear') await this.clearBrowserData();
  }

  private async clearBrowserData(): Promise<void> {
    const ok = await confirmDialog(
      'ブラウザ内データの消去',
      'このエディタがブラウザ内に保存したすべてのタブと設定を削除し、ページを再読み込みします。\n削除したデータは元に戻せません。必要であれば先にバックアップを書き出してください。',
      '消去する',
      { danger: true },
    );
    if (!ok || !this.app.backend) return;
    this.app.persistence.suspend();
    await this.app.backend.clear();
    location.reload();
  }

  /** 読み込めなかった保存データをそのまま書き出す（復旧用） */
  async dumpRawStorage(): Promise<void> {
    if (!this.app.backend) return;
    const raw = await this.app.backend.dumpRaw();
    const json = JSON.stringify(raw, null, 2);
    downloadBlob(new Blob([json], { type: 'application/json' }), `editor-storage-dump-${timestamp()}.json`);
  }
}
