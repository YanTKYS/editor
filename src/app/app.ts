import { createId } from '../core/emitter';
import { detectMode, modeInfo, MODES } from '../core/modes';
import { MAX_PANES, PaneLayout } from '../core/paneLayout';
import { initialSettings, normalizeSettings } from '../core/settings';
import { TabStore, type TabChange } from '../core/tabStore';
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  type EditorMode,
  type LineEnding,
  type Settings,
  type TabMeta,
} from '../core/types';
import { EditorManager, type RestoreInfo } from '../editor/editorManager';
import { diffExportFileName, formatDiffExport } from '../files/diffExport';
import { downloadText } from '../files/fileIO';
import { StorageUnavailableError } from '../storage/backend';
import { LocalStorageBackend } from '../storage/localStorageBackend';
import { PersistenceController, type SaveStatus } from '../storage/persistence';
import { SCHEMA_VERSION } from '../storage/schema';
import { confirmDialog, isDialogOpen, promptDialog, showDialog } from '../ui/dialogs';
import { h } from '../ui/dom';
import { FindPanel } from '../ui/findPanel';
import { DiffBar } from '../ui/diffBar';
import { showDiffDialog } from '../ui/diffDialog';
import { MenuBar } from '../ui/menuBar';
import { Notifications } from '../ui/notifications';
import { PaneArea } from '../ui/paneArea';
import { closePopup, PopupMenu, type MenuItem } from '../ui/popupMenu';
import { MarkdownPreview } from '../ui/preview';
import { StatusBar } from '../ui/statusBar';
import { TabBar } from '../ui/tabBar';
import { DiffController } from './diffController';
import { FileCommands } from './fileCommands';
import { buildMenus, buildToolbar } from './menus';
import { SearchController } from './searchController';
import { commandForEvent, type CommandId } from './shortcuts';
import { columnAt, countChars, offsetForColumn } from './textStats';

export const APP_NAME = 'Web Text Editor';
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

interface ClosedTab {
  meta: TabMeta;
  content: string;
  index: number;
  restore: RestoreInfo;
}

const CLOSED_TAB_LIMIT = 20;

/**
 * アプリ全体の組み立てと調停を行う。
 * タブモデル (TabStore)・エディタ (EditorManager)・保存 (PersistenceController)・各 UI 部品をつなぐ。
 */
export class App {
  readonly store = new TabStore();
  /** 画面分割（どのペインにどのタブを表示するか） */
  readonly layout = new PaneLayout();
  readonly instanceId = createId();
  readonly notifications = new Notifications();
  readonly backend: LocalStorageBackend | null;
  readonly persistence: PersistenceController;
  editor!: EditorManager;
  settings: Settings = initialSettings();
  findPanel!: FindPanel;
  preview!: MarkdownPreview;
  statusBar!: StatusBar;
  tabBar!: TabBar;
  menuBar!: MenuBar;
  paneArea!: PaneArea;
  /** 差分比較（既存のタブ・ペインに差分表示を付加する） */
  diff!: DiffController;
  diffBar!: DiffBar;
  readonly search: SearchController;
  readonly files: FileCommands;

  private closedTabs: ClosedTab[] = [];
  /** 読み込み時に改行コードが混在していたタブ */
  readonly mixedEol = new Set<string>();
  private cursorDirty = false;
  private statusQueued = false;
  private splitter!: HTMLElement;
  private workspace!: HTMLElement;
  private operationTarget!: HTMLElement;
  private fileState!: HTMLElement;
  private dropOverlay!: HTMLElement;
  private channel: BroadcastChannel | null = null;

  constructor() {
    let backend: LocalStorageBackend | null = null;
    try {
      backend = LocalStorageBackend.create();
    } catch (e) {
      if (!(e instanceof StorageUnavailableError)) throw e;
    }
    this.backend = backend;
    this.persistence = new PersistenceController(
      backend,
      {
        buildMeta: () => this.buildMeta(),
        getContent: (id) => this.editor.getContent(id),
      },
      this.instanceId,
    );
    this.search = new SearchController(this);
    this.files = new FileCommands(this);
  }

  /* ====================================================================== */
  /* 起動                                                                    */
  /* ====================================================================== */

  async start(root: HTMLElement): Promise<void> {
    this.buildLayout(root);
    await this.restore();
    this.wireGlobalEvents();
    this.applySettingsToDocument();
    this.updatePreview(true);
    this.scheduleStatusUpdate();
    this.announceInstance();
    this.editor.focus();
    document.documentElement.dataset.ready = 'true';
  }

  private buildLayout(root: HTMLElement): void {
    this.menuBar = new MenuBar(buildMenus(this));
    this.tabBar = new TabBar(this.store, {
      activate: (id) => this.activateTab(id),
      close: (id) => void this.closeTab(id),
      rename: (id) => void this.renameTab(id),
      create: () => this.newTab(),
      move: (id, index) => this.store.move(id, index),
      contextMenu: (id) => this.tabContextMenu(id),
      paneOf: (id) => this.layout.paneOf(id),
      paneCount: () => this.layout.count,
    });
    this.statusBar = new StatusBar({
      pickMode: (el) => this.showModeMenu(el),
      pickEol: (el) => this.showEolMenu(el),
      pickIndent: (el) => this.showIndentMenu(el),
      gotoLine: () => void this.gotoLine(),
      showStorageInfo: () => void this.files.showStorageInfo(),
    });
    this.findPanel = new FindPanel(this.search);
    this.preview = new MarkdownPreview();
    this.paneArea = new PaneArea({
      activatePane: (i) => this.layout.setActive(i),
      dropTab: (id, i) => this.showTabInPane(id, i, true),
      pickTab: (i, anchor) => this.showPanePicker(i, anchor),
    });
    this.diffBar = new DiffBar({
      previous: () => this.diff.previous(),
      next: () => this.diff.next(),
      change: () => void this.openDiffDialog(),
      export: () => this.exportDiff(),
      end: () => this.endDiff(),
    });
    this.splitter = h('div', {
      class: 'splitter',
      attrs: {
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': 'プレビューの幅を変更',
        tabindex: '0',
      },
    });
    const split = h('div', { class: 'split' }, [this.paneArea.el, this.splitter, this.preview.el]);
    this.operationTarget = h('span', { class: 'operation-target' });
    this.fileState = h('span', { class: 'operation-file-state' });
    const context = h('div', { class: 'operation-context', attrs: { 'aria-label': '現在の操作対象' } }, [
      this.operationTarget,
      this.fileState,
    ]);
    this.workspace = h('main', { class: 'workspace' }, [
      context, this.findPanel.el, this.diffBar.el, split, this.findPanel.resultsEl,
    ]);
    this.dropOverlay = h('div', { class: 'drop-overlay', attrs: { 'aria-hidden': 'true' } }, [
      h('div', { class: 'drop-message', text: 'ドロップしてファイルを開く' }),
    ]);
    this.dropOverlay.hidden = true;
    const header = h('header', { class: 'app-header' }, [this.menuBar.el, buildToolbar(this)]);
    root.replaceChildren(
      header,
      this.tabBar.el,
      this.notifications.bannerArea,
      this.workspace,
      this.statusBar.el,
      this.notifications.toastArea,
      this.dropOverlay,
    );
    this.editor = new EditorManager(this.settings, {
      onDocChange: (id) => this.onDocChange(id),
      onCursorActivity: (id) => this.onCursorActivity(id),
      onScroll: (id) => this.onEditorScroll(id),
    });
    this.editor.attachPane(0, this.paneArea.host(0));
    this.setupSplitter();
    this.store.events.on('change', (c) => this.onStoreChange(c));
    this.layout.events.on('change', () => this.syncPanes());
    // ペイン配置の変更を先に画面へ反映してから、比較を続けられるかを判定する
    this.diff = new DiffController({
      layout: this.layout,
      store: this.store,
      editor: this.editor,
      notify: (message) => this.notifications.toast(message),
    });
    this.diff.events.on('change', () => this.updateDiffUi());
    this.persistence.events.on('status', (s) => this.onSaveStatus(s));
  }

  /** 保存データからタブ構成と設定を復元する */
  private async restore(): Promise<void> {
    const result = this.backend ? await this.backend.load() : ({ status: 'empty' } as const);
    if (result.status === 'ok') {
      this.settings = result.meta.settings;
      this.editor.applySettings(this.settings);
      const metas: TabMeta[] = [];
      for (const t of result.meta.tabs) {
        const { selection, scrollPos, ...meta } = t;
        this.editor.addTab(meta.id, meta.mode, meta.eol, result.contents.get(meta.id) ?? '', {
          selection,
          scrollPos,
        });
        metas.push(meta);
      }
      this.layout.load(result.meta.layout, metas.map((m) => m.id), true);
      this.store.reset(metas, result.meta.activeTabId);
      if (this.store.count === 0) this.newTab({ focus: false });
      this.persistence.start(result.meta.revision, result.meta.savedAt);
      if (result.missing.length) {
        this.notifications.banner(
          'missing',
          `${result.missing.length} 個のタブの本文が保存データに見つかりませんでした（空のタブとして復元しています）。`,
          'warning',
          [],
          true,
        );
      }
    } else {
      this.editor.applySettings(this.settings);
      this.newTab({ focus: false });
      if (result.status === 'error') {
        this.persistence.start(0);
        this.persistence.block(result.message);
      } else {
        this.persistence.start(this.backend?.currentRevision()?.revision ?? 0);
      }
    }
    this.onSaveStatus(this.persistence.status);
    this.updateTitle();
  }

  /* ====================================================================== */
  /* イベント                                                                */
  /* ====================================================================== */

  private onStoreChange(c: TabChange): void {
    if (c.type === 'add' || c.type === 'remove' || c.type === 'reset' ||
        (c.type === 'update' && c.keys.includes('name'))) {
      this.search.invalidateResults();
    }
    switch (c.type) {
      case 'add':
        this.persistence.markTabDirty(c.id);
        break;
      case 'remove':
        this.editor.removeTab(c.id);
        this.mixedEol.delete(c.id);
        this.persistence.markTabRemoved(c.id);
        // 表示していたペインには近くのタブ（なければ空）を表示する
        this.layout.removeTab(c.id, this.store.all.map((t) => t.id), c.index);
        break;
      case 'update': {
        const tab = this.store.get(c.id);
        if (!tab) break;
        if (c.keys.includes('mode')) this.editor.setMode(c.id, tab.mode);
        if (c.keys.includes('eol')) {
          this.editor.setEol(c.id, tab.eol);
          this.mixedEol.delete(c.id);
        }
        if (c.keys.includes('name') || c.keys.includes('modifiedSinceFile')) {
          this.paneArea.render(this.layout, this.store);
          if (c.keys.includes('name') && this.diff.active) this.updateDiffUi();
        }
        if (c.id === this.store.activeTabId) {
          this.updateTitle();
          this.scheduleStatusUpdate();
          if (c.keys.includes('mode')) this.updatePreview(true);
        }
        this.persistence.markMetaDirty();
        break;
      }
      case 'activate':
        this.onActiveTabChanged();
        break;
      case 'reset':
        // タブがすべて入れ替わるため、差分比較は続けられない
        this.diff.end(false);
        // ペインの配置は呼び出し側で設定済み（保存データ・バックアップの配置を空のペインも含めてそのまま使う）。
        // ここでは存在しないタブを外すだけで、空のペインへの補完は行わない
        this.layout.reconcile(this.store.all.map((t) => t.id));
        this.syncPanes();
        this.onActiveTabChanged();
        break;
      case 'move':
        this.persistence.markMetaDirty();
        break;
    }
  }

  private onDocChange(id: string): void {
    this.search.invalidateResults();
    this.diff.onDocChange(id);
    this.persistence.markTabDirty(id);
    const tab = this.store.get(id);
    if (tab && !tab.modifiedSinceFile) this.store.update(id, { modifiedSinceFile: true });
    if (id === this.store.activeTabId) {
      this.updatePreview(false);
      this.search.onDocChanged();
    }
  }

  private onCursorActivity(id: string): void {
    if (id !== this.store.activeTabId) return;
    this.cursorDirty = true;
    this.scheduleStatusUpdate();
    this.search.onSelectionChanged();
  }

  /** アクティブなタブ（アクティブなペインの表示内容）が変わった */
  private onActiveTabChanged(): void {
    this.updateTitle();
    this.updatePreview(true);
    this.search.onActiveTabChanged();
    this.scheduleStatusUpdate();
    this.persistence.markMetaDirty();
  }

  private onEditorScroll(id: string): void {
    this.cursorDirty = true;
    if (id !== this.store.activeTabId) return;
    if (!this.preview.visible) return;
    const s = this.editor.view.scrollDOM;
    const max = s.scrollHeight - s.clientHeight;
    this.preview.syncScroll(max > 0 ? s.scrollTop / max : 0);
  }

  private wireGlobalEvents(): void {
    window.addEventListener('keydown', (e) => this.onGlobalKey(e), true);
    // 閉じる・非表示時に未保存の変更を書き込む。
    // localStorage への書き込みは同期的に行われ、flush() から戻った時点で成否が確定している。
    const flushNow = () => {
      if (this.cursorDirty) {
        this.cursorDirty = false;
        this.persistence.markMetaDirty();
      }
      void this.persistence.flush();
    };
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushNow();
    });
    window.addEventListener('beforeunload', (e) => {
      flushNow();
      // 保存に失敗した・保存を停止している（競合等）・書き込み完了待ちの変更があれば警告する
      if (this.persistence.hasUnsavedChanges || this.persistence.status.kind === 'error') {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    // ファイルのドラッグ＆ドロップ
    let dragDepth = 0;
    const isFileDrag = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!isFileDrag(e)) return;
      dragDepth++;
      this.dropOverlay.hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
      if (!isFileDrag(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) this.dropOverlay.hidden = true;
    });
    window.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('drop', (e) => {
      dragDepth = 0;
      this.dropOverlay.hidden = true;
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      void this.files.openFiles(Array.from(e.dataTransfer.files), 'UTF-8');
    });
  }

  private onGlobalKey(e: KeyboardEvent): void {
    if (isDialogOpen()) return;
    const command = commandForEvent(e);
    if (!command) return;
    e.preventDefault();
    e.stopPropagation();
    closePopup();
    this.run(command);
  }

  /** ショートカット・メニューから呼ばれるコマンド */
  run(command: CommandId): void {
    switch (command) {
      case 'newTab':
        this.newTab();
        break;
      case 'openFile':
        void this.files.openWithPicker('UTF-8');
        break;
      case 'saveBrowser':
        void this.saveToBrowser();
        break;
      case 'exportFile':
        void this.files.exportActive(false);
        break;
      case 'find':
        this.search.open('find');
        break;
      case 'replace':
        this.search.open('replace');
        break;
      case 'findNext':
        this.search.findNext();
        break;
      case 'findPrevious':
        this.search.findPrevious();
        break;
      case 'findInTabs':
        this.search.openAndSearchAll();
        break;
      case 'gotoLine':
        void this.gotoLine();
        break;
      case 'nextTab':
        this.cycleTab(1);
        break;
      case 'prevTab':
        this.cycleTab(-1);
        break;
      case 'closeTab':
        if (this.store.activeTabId) void this.closeTab(this.store.activeTabId);
        break;
      case 'reopenTab':
        this.reopenClosedTab();
        break;
      case 'renameTab':
        if (this.store.activeTabId) void this.renameTab(this.store.activeTabId);
        break;
      case 'toggleWrap':
        this.updateSettings({ wordWrap: !this.settings.wordWrap });
        break;
      case 'togglePreview':
        this.togglePreview();
        break;
      case 'diffNext':
        this.diff.next();
        break;
      case 'diffPrev':
        this.diff.previous();
        break;
      case 'focusPane1':
      case 'focusPane2':
      case 'focusPane3':
      case 'focusPane4':
        this.focusPane(Number(command.slice(-1)) - 1);
        break;
    }
  }

  /* ====================================================================== */
  /* タブ操作                                                                */
  /* ====================================================================== */

  /** タブを追加する（アクティブにはしない） */
  addTab(init: Partial<TabMeta>, content: string, restore?: RestoreInfo, index?: number): TabMeta {
    const id = init.id ?? createId();
    const name = init.name ?? this.store.nextUntitledName();
    const mode = init.mode ?? detectMode(name);
    const eol = init.eol ?? 'LF';
    this.editor.addTab(id, mode, eol, content, restore);
    return this.store.create({ ...init, id, name, mode, eol }, index);
  }

  newTab(options: { focus?: boolean } = {}): TabMeta {
    const tab = this.addTab({}, '');
    this.activateTab(tab.id, options.focus ?? true);
    return tab;
  }

  /**
   * タブをアクティブにする。他のペインに表示中ならそのペインをアクティブにし、
   * そうでなければアクティブなペインに表示する。
   */
  activateTab(id: string, focus = false): void {
    if (!this.store.get(id)) return;
    const pane = this.layout.paneOf(id);
    if (pane >= 0) this.layout.setActive(pane);
    else this.layout.show(id, this.layout.active);
    if (focus) this.editor.focus();
  }

  /* ====================================================================== */
  /* 画面分割                                                                */
  /* ====================================================================== */

  /** ペインの配置をエディタ・画面に反映する（配置が変わるたびに呼ばれる） */
  private syncPanes(): void {
    const { layout } = this;
    for (let i = 0; i < layout.count; i++) this.editor.attachPane(i, this.paneArea.host(i));
    for (let i = 0; i < MAX_PANES; i++) this.editor.showInPane(i, i < layout.count ? layout.tabs[i] : null);
    this.editor.setActivePane(layout.active);
    this.paneArea.render(layout, this.store);
    this.tabBar.render();
    this.updateSplitButtons();
    // TabStore のアクティブタブは「アクティブなペインに表示しているタブ」とする
    this.store.activate(layout.activeTabId);
    this.scheduleStatusUpdate();
    this.editor.requestMeasure();
    this.persistence.markMetaDirty();
  }

  /** 分割数を変更する（閉じたペインのタブは削除せず、表示しなくなるだけ） */
  setPaneCount(count: number): void {
    this.layout.setCount(count, this.store.all.map((t) => t.id));
    this.editor.focus();
  }

  /** タブを指定のペインに表示する（他のペインに表示中なら移動する） */
  showTabInPane(id: string, pane: number, focus = false): void {
    if (!this.store.get(id) || pane >= this.layout.count) return;
    this.layout.show(id, pane, true);
    if (focus) this.editor.focus();
  }

  focusPane(pane: number): void {
    if (pane >= this.layout.count) return;
    this.layout.setActive(pane);
    this.editor.focus();
  }

  /* ====================================================================== */
  /* 差分比較                                                                */
  /* ====================================================================== */

  /** 比較元・比較先・結果表示の 3 つのペインを選んで差分比較を開始する（比較中なら指定を変更する） */
  async openDiffDialog(): Promise<void> {
    if (this.store.count < 2) {
      this.notifications.toast('差分比較には 2 つ以上のタブが必要です。2 つのファイルを開いてください。');
      return;
    }
    const plan = this.diff.planLayout();
    const targets = await showDiffDialog({
      paneNames: plan.map((id) => (id ? (this.store.get(id)?.name ?? null) : null)),
      expandedFrom: this.layout.count < plan.length ? this.layout.count : null,
      changing: this.diff.active,
      initial: this.diff.defaultTargets(plan),
      validate: (t) => this.diff.validate(t, plan),
    });
    // キャンセルした場合は、ペイン配置を変更しない
    if (!targets || !this.diff.start(targets, plan)) return;
    this.editor.focus();
  }

  endDiff(): void {
    this.diff.end(true);
    this.editor.focus();
  }

  exportDiff(): void {
    try {
      const snapshot = this.diff.snapshotForExport();
      if (!snapshot) return this.notifications.toast('差分比較を開始してから書き出してください。');
      const now = new Date();
      downloadText(formatDiffExport(snapshot, now), diffExportFileName(now), 'LF', false);
      this.notifications.toast('差分テキストのダウンロードを開始しました。');
    } catch {
      this.notifications.toast('差分テキストを書き出せませんでした。元のタブの状態は変更していません。');
    }
  }

  /** 保存用のペイン配置（差分比較中も、結果表示のために外したタブを元のペインに戻した配置を保存する） */
  layoutForSave() {
    return this.diff.layoutForSave();
  }

  private updateDiffUi(): void {
    const st = this.diff.status;
    const label = (pane: number, id?: string) => `ペイン ${pane + 1}${id ? `: ${this.store.get(id)?.name ?? ''}` : ''}`;
    this.diffBar.update(
      st && {
        aName: label(st.a, st.aTab),
        bName: label(st.b, st.bTab),
        resultName: label(st.result),
        added: st.added,
        deleted: st.deleted,
        changed: st.changed,
        total: st.total,
        current: st.current,
        precise: st.precise,
      },
    );
    this.paneArea.setDiffRoles(st && { a: st.a, b: st.b, result: st.result });
    this.scheduleStatusUpdate();
    this.editor.requestMeasure();
  }

  /** ペインに表示するタブを選ぶメニュー */
  showPanePicker(pane: number, anchor: HTMLElement): void {
    this.layout.setActive(pane);
    const items: MenuItem[] = this.store.all.map((t) => {
      const shownIn = this.layout.paneOf(t.id);
      return {
        label: `${t.modifiedSinceFile ? '● ' : ''}${t.name}${shownIn >= 0 && shownIn !== pane ? `（ペイン ${shownIn + 1} に表示中）` : ''}`,
        checked: shownIn === pane,
        action: () => this.showTabInPane(t.id, pane, true),
      };
    });
    if (this.layout.tabs[pane]) {
      items.push({ separator: true }, { label: 'このペインを空にする', action: () => this.layout.show(null, pane) });
    }
    new PopupMenu(items, { label: `ペイン ${pane + 1} に表示するタブ` }).showAt(anchor);
  }

  private updateSplitButtons(): void {
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-split]')) {
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.split) === this.layout.count));
    }
  }

  cycleTab(offset: number): void {
    const id = this.store.neighbor(offset);
    if (id) this.activateTab(id, true);
  }

  /** 空で未変更の「新規」タブか（ファイルを開いたときに置き換える対象） */
  isPristine(id: string): boolean {
    const tab = this.store.get(id);
    return !!tab && this.editor.getLength(id) === 0 && !tab.modifiedSinceFile && /^新規 \d+$/.test(tab.name);
  }

  async closeTab(id: string, options: { confirm?: boolean } = {}): Promise<boolean> {
    const tab = this.store.get(id);
    if (!tab) return false;
    const content = this.editor.getContent(id);
    if ((options.confirm ?? true) && content.length > 0 && tab.modifiedSinceFile) {
      const answer = await showDialog<'cancel' | 'export' | 'close'>({
        title: 'タブを閉じる',
        message: `「${tab.name}」を閉じますか？\nこのタブの内容はファイルに書き出されていません。閉じるとブラウザ内の保存データからも削除されます。\n（閉じた直後であれば「ファイル」→「閉じたタブを開き直す」(Alt+Shift+T) で元に戻せます）`,
        cancelValue: 'cancel',
        buttons: [
          { label: 'キャンセル', value: 'cancel' },
          { label: '書き出してから閉じる', value: 'export' },
          { label: '閉じる', value: 'close', primary: true, danger: true },
        ],
      });
      if (answer === 'cancel') return false;
      if (answer === 'export') this.files.exportTab(id, tab.name);
      if (!this.store.get(id)) return false;
    }
    if (!this.isPristine(id)) {
      this.closedTabs.push({
        meta: { ...tab },
        content,
        index: this.store.indexOf(id),
        restore: { selection: this.editor.getSelection(id), scrollPos: this.editor.getScrollPos(id) },
      });
      if (this.closedTabs.length > CLOSED_TAB_LIMIT) this.closedTabs.shift();
    }
    if (this.store.count === 1) this.addTab({}, '');
    this.store.remove(id);
    this.editor.focus();
    return true;
  }

  async closeOtherTabs(keepId: string): Promise<void> {
    const others = this.store.all.filter((t) => t.id !== keepId);
    const unsaved = others.filter((t) => t.modifiedSinceFile && this.editor.getLength(t.id) > 0);
    if (unsaved.length) {
      const ok = await confirmDialog(
        '他のタブをすべて閉じる',
        `${others.length} 個のタブを閉じます。そのうち ${unsaved.length} 個はファイルに書き出されていない変更があります。\n閉じたタブは「閉じたタブを開き直す」で 1 つずつ復元できます（最大 ${CLOSED_TAB_LIMIT} 個）。`,
        '閉じる',
        { danger: true },
      );
      if (!ok) return;
    }
    for (const t of others) await this.closeTab(t.id, { confirm: false });
    this.activateTab(keepId, true);
  }

  get canReopenTab(): boolean {
    return this.closedTabs.length > 0;
  }

  reopenClosedTab(): void {
    const closed = this.closedTabs.pop();
    if (!closed) {
      this.notifications.toast('開き直せるタブはありません。');
      return;
    }
    const tab = this.addTab({ ...closed.meta, id: createId() }, closed.content, closed.restore, closed.index);
    this.activateTab(tab.id, true);
  }

  async renameTab(id: string): Promise<void> {
    const tab = this.store.get(id);
    if (!tab) return;
    const name = await promptDialog('タブ名の変更', '新しい名前（拡張子で編集モードを自動判定します）', tab.name, {
      okLabel: '変更',
      selectBaseName: true,
      validate: (v) =>
        !v.trim() ? '名前を入力してください。' : v.trim().length > 255 ? '名前が長すぎます（255 文字まで）。' : null,
    });
    if (name === null) return;
    this.applyRename(id, name);
    this.editor.focus();
  }

  /** 名前変更（拡張子が変わった場合は編集モードも切り替える） */
  applyRename(id: string, name: string): void {
    const tab = this.store.get(id);
    if (!tab) return;
    const oldMode = detectMode(tab.name);
    const newMode = detectMode(name.trim());
    if (!this.store.rename(id, name)) return;
    if (oldMode !== newMode) this.store.update(id, { mode: newMode });
  }

  moveActiveTab(offset: number): void {
    const id = this.store.activeTabId;
    if (id) this.store.move(id, this.store.indexOf(id) + offset);
  }

  setMode(mode: EditorMode): void {
    const id = this.store.activeTabId;
    if (id) this.store.update(id, { mode });
  }

  setEol(eol: LineEnding): void {
    const id = this.store.activeTabId;
    if (!id) return;
    const tab = this.store.get(id);
    if (tab && (tab.eol !== eol || this.mixedEol.has(id))) {
      this.store.update(id, { eol, modifiedSinceFile: true });
      this.mixedEol.delete(id);
      this.scheduleStatusUpdate();
    }
  }

  private tabContextMenu(id: string): MenuItem[] {
    const tab = this.store.get(id);
    const idx = this.store.indexOf(id);
    return [
      { label: '名前の変更…', shortcut: 'F2', action: () => void this.renameTab(id) },
      {
        label: 'ファイルに書き出し（ダウンロード）',
        action: () => tab && this.files.exportTab(id, tab.name),
      },
      { separator: true },
      { label: '左へ移動', disabled: idx <= 0, action: () => this.store.move(id, idx - 1) },
      {
        label: '右へ移動',
        disabled: idx >= this.store.count - 1,
        action: () => this.store.move(id, idx + 1),
      },
      { separator: true },
      { label: 'タブを閉じる', shortcut: 'Alt+W', action: () => void this.closeTab(id) },
      {
        label: '他のタブをすべて閉じる',
        disabled: this.store.count <= 1,
        action: () => void this.closeOtherTabs(id),
      },
    ];
  }

  /* ====================================================================== */
  /* 編集補助                                                                */
  /* ====================================================================== */

  async gotoLine(): Promise<void> {
    const id = this.store.activeTabId;
    if (!id) return;
    const state = this.editor.view.state;
    const total = state.doc.lines;
    const current = state.doc.lineAt(state.selection.main.head).number;
    const parse = (v: string) => {
      const m = /^\s*(\d+)\s*(?:[:：,]\s*(\d+)\s*)?$/.exec(v.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
      return m ? { line: Number(m[1]), col: m[2] ? Number(m[2]) : 1 } : null;
    };
    const input = await promptDialog('指定行へ移動', `行番号（1〜${total}）。「行:列」形式も可`, String(current), {
      okLabel: '移動',
      inputMode: 'numeric',
      validate: (v) => {
        const p = parse(v);
        if (!p) return '行番号を数字で入力してください。';
        if (p.line < 1 || p.line > total) return `1〜${total} の範囲で入力してください。`;
        return null;
      },
    });
    if (input === null) return;
    const p = parse(input);
    if (!p) return;
    const line = this.editor.view.state.doc.line(Math.min(p.line, this.editor.view.state.doc.lines));
    const pos = line.from + offsetForColumn(line.text, p.col);
    this.editor.select(id, pos);
    this.editor.focus();
  }

  /** CodeMirror のコマンドをアクティブなエディタで実行する */
  runEditorCommand(cmd: (view: EditorManager['view']) => boolean): void {
    if (!this.store.activeTabId) return;
    cmd(this.editor.view);
    this.editor.focus();
  }

  /* ====================================================================== */
  /* 設定                                                                    */
  /* ====================================================================== */

  updateSettings(patch: Partial<Settings>): void {
    const next = normalizeSettings({ ...this.settings, ...patch }, this.settings);
    const changed = (Object.keys(next) as (keyof Settings)[]).some((k) => next[k] !== this.settings[k]);
    if (!changed) return;
    const layoutOnly = Object.keys(patch).every((k) => k === 'previewRatio');
    this.settings = next;
    if (!layoutOnly) this.editor.applySettings(next);
    this.applySettingsToDocument();
    this.updatePreview(false);
    this.scheduleStatusUpdate();
    this.persistence.markMetaDirty();
  }

  changeFontSize(delta: number | 'reset'): void {
    const size = delta === 'reset' ? 14 : this.settings.fontSize + delta;
    this.updateSettings({ fontSize: Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size)) });
  }

  private applySettingsToDocument(): void {
    const root = document.documentElement;
    root.dataset.theme = this.settings.theme;
    root.style.setProperty('--editor-font-size', `${this.settings.fontSize}px`);
    root.style.colorScheme = this.settings.theme;
    this.workspace.style.setProperty('--preview-ratio', String(this.settings.previewRatio));
    this.editor.requestMeasure();
  }

  togglePreview(): void {
    const tab = this.store.active;
    if (tab && tab.mode !== 'markdown' && !this.settings.markdownPreview) {
      this.notifications.toast('Markdown モードのタブでプレビューが表示されます。');
    }
    this.updateSettings({ markdownPreview: !this.settings.markdownPreview });
  }

  /** プレビューの表示・内容を更新する */
  updatePreview(immediate: boolean): void {
    const tab = this.store.active;
    const show = !!tab && tab.mode === 'markdown' && this.settings.markdownPreview;
    const wasVisible = this.preview.visible;
    this.preview.setVisible(show);
    this.splitter.hidden = !show;
    this.workspace.classList.toggle('with-preview', show);
    if (!show || !tab) {
      if (wasVisible) this.preview.reset();
      return;
    }
    if (immediate || !wasVisible) {
      this.preview.reset();
      void this.preview.render(this.editor.getContent(tab.id));
    } else {
      this.preview.update(this.editor.getContent(tab.id));
    }
  }

  private setupSplitter(): void {
    const el = this.splitter;
    el.hidden = true;
    const split = el.parentElement as HTMLElement;
    const setRatio = (ratio: number, persist: boolean) => {
      const r = Math.min(0.85, Math.max(0.15, ratio));
      if (persist) this.updateSettings({ previewRatio: r });
      else this.workspace.style.setProperty('--preview-ratio', String(r));
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const vertical = getComputedStyle(split).flexDirection === 'column';
      const rect = split.getBoundingClientRect();
      const ratioAt = (ev: PointerEvent) =>
        vertical ? (rect.bottom - ev.clientY) / rect.height : (rect.right - ev.clientX) / rect.width;
      const move = (ev: PointerEvent) => setRatio(ratioAt(ev), false);
      const up = (ev: PointerEvent) => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        setRatio(ratioAt(ev), true);
        this.editor.requestMeasure();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? -0.05 : 0;
      if (!step) return;
      e.preventDefault();
      setRatio(this.settings.previewRatio + step, true);
    });
  }

  /* ====================================================================== */
  /* 保存                                                                    */
  /* ====================================================================== */

  private buildMeta() {
    return {
      schemaVersion: SCHEMA_VERSION,
      app: '',
      activeTabId: this.store.activeTabId,
      settings: this.settings,
      layout: this.layoutForSave(),
      tabs: this.store.all.map((t) => ({
        ...t,
        selection: this.editor.getSelection(t.id),
        scrollPos: this.editor.getScrollPos(t.id),
      })),
    };
  }

  /** Ctrl+S: ブラウザ内（localStorage）へ直ちに保存する */
  async saveToBrowser(): Promise<void> {
    this.cursorDirty = false;
    this.persistence.markMetaDirty();
    const status = this.persistence.status.kind;
    if (status === 'conflict' || status === 'blocked' || status === 'unavailable') {
      this.notifications.toast('ブラウザ内保存は現在停止しています。画面上部の案内をご確認ください。', 'warning');
      return;
    }
    const ok = await this.persistence.flush();
    if (ok) {
      this.notifications.toast('ブラウザ内に保存しました（ファイルへの書き出しは Ctrl+Shift+S）', 'success', 2500);
    }
  }

  private onSaveStatus(s: SaveStatus): void {
    const n = this.notifications;
    const backupAction = { label: 'バックアップを書き出す', action: () => this.files.exportBackup() };
    switch (s.kind) {
      case 'saved': {
        const time = s.at ? new Date(s.at).toLocaleTimeString('ja-JP') : '';
        this.statusBar.setSaveState('自動保存済み', 'ok', time ? `最終保存: ${time}` : '変更はありません');
        n.dismiss('storage');
        break;
      }
      case 'pending':
        this.statusBar.setSaveState('自動保存待ち…', 'pending', 'まもなくブラウザ内に自動保存します');
        if (n.has('storage') && this.persistence.status.kind === 'pending') n.dismiss('storage');
        break;
      case 'error':
        this.statusBar.setSaveState('保存失敗', 'error', s.message);
        n.banner(
          'storage',
          s.reason === 'quota'
            ? 'ブラウザ内への保存に失敗しました（保存容量の不足）。編集内容は画面上に残っていますが、このまま閉じると失われます。不要なタブを閉じるか、ファイル・バックアップに書き出してください。'
            : `ブラウザ内への保存に失敗しました: ${s.message}。編集内容は画面上に残っています。`,
          'error',
          [
            { label: '再試行', primary: true, action: () => void this.saveToBrowser() },
            backupAction,
            { label: '保存領域の情報', action: () => void this.files.showStorageInfo() },
          ],
        );
        break;
      case 'conflict':
        this.statusBar.setSaveState('保存停止（競合）', 'warning', '別のブラウザタブで保存データが更新されました');
        n.banner(
          'storage',
          '別のブラウザタブでこのエディタのデータが保存されました。上書きを防ぐため、このタブの自動保存を停止しています。',
          'warning',
          [
            { label: '保存データを読み込み直す', action: () => void this.reloadFromStorage() },
            { label: 'このタブの内容で上書き保存', action: () => void this.overwriteStorage() },
            backupAction,
          ],
        );
        break;
      case 'blocked':
        this.statusBar.setSaveState('保存停止', 'error', s.message);
        n.banner(
          'storage',
          `${s.message} データ保護のため自動保存を停止しています。`,
          'error',
          [
            { label: '保存データを書き出す', action: () => void this.files.dumpRawStorage() },
            { label: '保存データを初期化して保存を再開', action: () => void this.resetBlockedStorage() },
          ],
        );
        break;
      case 'unavailable':
        this.statusBar.setSaveState('保存不可', 'error', 'ブラウザ内保存を利用できません');
        n.banner(
          'storage',
          'このブラウザではブラウザ内保存（localStorage）を利用できません。編集内容は自動保存されないため、ファイルに書き出してください。',
          'error',
          [backupAction],
        );
        break;
    }
  }

  private async reloadFromStorage(): Promise<void> {
    const ok = await confirmDialog(
      '保存データを読み込み直す',
      'ブラウザ内の保存データ（別のタブで保存された内容）を読み込み直します。\nこのタブで保存されていない変更は失われます。必要であれば先にバックアップを書き出してください。',
      '読み込み直す',
      { danger: true },
    );
    if (!ok) return;
    this.persistence.suspend();
    location.reload();
  }

  private async overwriteStorage(): Promise<void> {
    const ok = await confirmDialog(
      'このタブの内容で上書き保存',
      '別のブラウザタブで保存された内容を、このタブの内容で上書きします。\n別のタブで行った変更は失われます。',
      '上書き保存',
      { danger: true },
    );
    if (!ok) return;
    const success = await this.persistence.overwrite(this.store.all.map((t) => t.id));
    if (success) this.notifications.toast('このタブの内容で上書き保存しました。', 'success');
  }

  private async resetBlockedStorage(): Promise<void> {
    const ok = await confirmDialog(
      '保存データの初期化',
      '読み込めなかったブラウザ内の保存データを削除し、現在の内容で保存を再開します。\n削除したデータは元に戻せません。必要であれば先に「保存データを書き出す」を実行してください。',
      '初期化して再開',
      { danger: true },
    );
    if (!ok) return;
    await this.backend?.clear();
    this.persistence.start(0);
    await this.persistence.overwrite(this.store.all.map((t) => t.id));
  }

  /** 別のブラウザタブで同じアプリが開かれていることを知らせる */
  private announceInstance(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel('webTextEditor');
    const warn = () =>
      this.notifications.banner(
        'multi',
        'このエディタは別のブラウザタブでも開かれています。両方で編集すると保存が競合するため、どちらか一方で編集してください。',
        'info',
        [],
        true,
      );
    this.channel.addEventListener('message', (e: MessageEvent<{ type: string; id: string }>) => {
      if (!e.data || e.data.id === this.instanceId) return;
      if (e.data.type === 'hello') {
        this.channel?.postMessage({ type: 'here', id: this.instanceId });
        warn();
      } else if (e.data.type === 'here') {
        warn();
      }
    });
    this.channel.postMessage({ type: 'hello', id: this.instanceId });
  }

  /* ====================================================================== */
  /* 表示更新                                                                */
  /* ====================================================================== */

  private updateTitle(): void {
    const tab = this.store.active;
    document.title = tab ? `${tab.name} - ${APP_NAME}` : APP_NAME;
  }

  scheduleStatusUpdate(): void {
    if (this.statusQueued) return;
    this.statusQueued = true;
    requestAnimationFrame(() => {
      this.statusQueued = false;
      this.updateStatus();
    });
  }

  private updateStatus(): void {
    const tab = this.store.active;
    const result = this.diff.status?.result === this.layout.active;
    const name = result ? '差分結果（読み取り専用）' : tab?.name ?? 'タブなし';
    const target = `操作対象：ペイン ${this.layout.active + 1} — ${name}`;
    this.operationTarget.textContent = target;
    this.operationTarget.title = `${target}\n${result || !tab
      ? 'このペインには検索・置換・書き出しの対象となるタブがありません。'
      : '検索・置換・書き出しは、このペインのタブが対象です（全タブ操作を除く）。'}`;
    this.fileState.hidden = !tab || result;
    this.fileState.textContent = tab?.modifiedSinceFile ? 'ファイル未書き出し ●' : 'ファイル変更なし';
    this.fileState.dataset.modified = String(!!tab?.modifiedSinceFile);
    this.fileState.title = tab?.modifiedSinceFile
      ? 'ブラウザ内の自動保存とは別に、PC への書き出しが必要な変更があります。'
      : '最後の読み込み・書き出し以降の変更はありません。新規の空タブもこの状態になります。';
    if (!tab) {
      this.statusBar.clear();
      return;
    }
    const state = this.editor.view.state;
    const main = state.selection.main;
    const line = state.doc.lineAt(main.head);
    let selectedChars = 0;
    let selectedLines = 0;
    for (const r of state.selection.ranges) {
      if (r.empty) continue;
      selectedChars += countChars(state.doc, r.from, r.to);
      selectedLines += state.doc.lineAt(r.to).number - state.doc.lineAt(r.from).number + 1;
    }
    this.statusBar.update({
      line: line.number,
      column: columnAt(line.text, main.head - line.from),
      chars: countChars(state.doc),
      lines: state.doc.lines,
      selectedChars,
      selectedLines,
      selections: state.selection.ranges.length,
      modeLabel: modeInfo(tab.mode).label,
      eol: tab.eol,
      mixedEol: this.mixedEol.has(tab.id),
      encoding:
        tab.encoding === 'Shift_JIS' ? 'Shift_JIS → UTF-8' : tab.bom ? 'UTF-8 (BOM)' : 'UTF-8',
      tabSize: this.settings.tabSize,
      indentWithTabs: this.settings.indentWithTabs,
    });
  }

  showModeMenu(anchor: HTMLElement): void {
    const current = this.store.active?.mode;
    new PopupMenu(
      MODES.map((m) => ({ label: m.label, checked: m.id === current, action: () => this.setMode(m.id) })),
      { label: '編集モード' },
    ).showAt(anchor, 'above');
  }

  showEolMenu(anchor: HTMLElement): void {
    const tab = this.store.active;
    const items: MenuItem[] = [{ heading: '書き出し時の改行コード' }];
    for (const [eol, label] of [
      ['CRLF', 'CRLF（Windows）'],
      ['LF', 'LF（Unix / macOS）'],
      ['CR', 'CR（旧 Mac）'],
    ] as const) {
      items.push({ label, checked: tab?.eol === eol, action: () => this.setEol(eol) });
    }
    new PopupMenu(items, { label: '改行コード' }).showAt(anchor, 'above');
  }

  showIndentMenu(anchor: HTMLElement): void {
    const s = this.settings;
    const items: MenuItem[] = [
      { label: 'スペースでインデント', checked: !s.indentWithTabs, action: () => this.updateSettings({ indentWithTabs: false }) },
      { label: 'タブ文字でインデント', checked: s.indentWithTabs, action: () => this.updateSettings({ indentWithTabs: true }) },
      { separator: true },
      { heading: 'タブ幅' },
      ...[2, 4, 8].map((n) => ({
        label: `${n}`,
        checked: s.tabSize === n,
        action: () => this.updateSettings({ tabSize: n }),
      })),
    ];
    new PopupMenu(items, { label: 'インデント' }).showAt(anchor, 'above');
  }
}
