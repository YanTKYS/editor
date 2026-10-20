import type { TabStore } from '../core/tabStore';
import type { TabMeta } from '../core/types';
import { h } from './dom';
import { PopupMenu, type MenuItem } from './popupMenu';

export interface TabBarActions {
  activate(id: string): void;
  close(id: string): void;
  rename(id: string): void;
  create(): void;
  move(id: string, toIndex: number): void;
  contextMenu(id: string): MenuItem[];
}

/**
 * タブバー。クリックで切り替え、ダブルクリックで名前変更、中クリック・×で閉じる、
 * ドラッグ＆ドロップで並べ替え。キーボードでは ←→ で移動、Delete で閉じる、F2 で名前変更。
 */
export class TabBar {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly addButton: HTMLButtonElement;
  private readonly listButton: HTMLButtonElement;
  private dragId: string | null = null;
  private renderQueued = false;

  constructor(
    private readonly store: TabStore,
    private readonly actions: TabBarActions,
  ) {
    this.list = h('div', {
      class: 'tab-list',
      attrs: { role: 'tablist', 'aria-label': '開いているタブ' },
    });
    this.addButton = h('button', {
      class: 'tab-action',
      text: '+',
      type: 'button',
      title: '新規タブ (Ctrl+N / Alt+N)',
      attrs: { 'aria-label': '新規タブ' },
      on: { click: () => this.actions.create() },
    });
    this.listButton = h('button', {
      class: 'tab-action',
      text: '▾',
      type: 'button',
      title: 'タブ一覧',
      attrs: { 'aria-label': 'タブ一覧', 'aria-haspopup': 'menu' },
      on: { click: () => this.showTabList() },
    });
    this.el = h('div', { class: 'tabbar' }, [this.list, this.addButton, this.listButton]);

    // ホイールで横スクロール
    this.list.addEventListener(
      'wheel',
      (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          this.list.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false },
    );
    this.list.addEventListener('dragover', (e) => this.onDragOver(e));
    this.list.addEventListener('drop', (e) => this.onDrop(e));
    this.list.addEventListener('dragleave', (e) => {
      if (!this.list.contains(e.relatedTarget as Node)) this.clearDropMarker();
    });
    // 空き領域のダブルクリックで新規タブ
    this.list.addEventListener('dblclick', (e) => {
      if (e.target === this.list) this.actions.create();
    });

    store.events.on('change', () => this.queueRender());
    this.render();
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  render(): void {
    const activeId = this.store.activeTabId;
    const hadFocus = this.list.contains(document.activeElement);
    const existing = new Map<string, HTMLElement>();
    for (const el of Array.from(this.list.children) as HTMLElement[]) {
      existing.set(el.dataset.id ?? '', el);
    }
    const fragment: HTMLElement[] = [];
    for (const tab of this.store.all) {
      const el = existing.get(tab.id) ?? this.createTab(tab.id);
      existing.delete(tab.id);
      this.updateTab(el, tab, tab.id === activeId);
      fragment.push(el);
    }
    for (const el of existing.values()) el.remove();
    fragment.forEach((el, i) => {
      if (this.list.children[i] !== el) this.list.insertBefore(el, this.list.children[i] ?? null);
    });
    if (activeId) {
      const activeEl = this.tabElement(activeId);
      activeEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (hadFocus) activeEl?.focus();
    }
  }

  private tabElement(id: string): HTMLElement | null {
    return this.list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
  }

  /** アクティブなタブ要素にフォーカスする */
  focusActive(): void {
    const id = this.store.activeTabId;
    if (id) this.tabElement(id)?.focus();
  }

  private createTab(id: string): HTMLElement {
    const label = h('span', { class: 'tab-label' });
    const dirty = h('span', { class: 'tab-dirty', attrs: { 'aria-hidden': 'true' } });
    const close = h('button', {
      class: 'tab-close',
      text: '×',
      type: 'button',
      attrs: { tabindex: '-1', 'aria-label': 'タブを閉じる' },
    });
    const el = h(
      'div',
      {
        class: 'tab',
        dataset: { id },
        attrs: { role: 'tab', draggable: 'true', tabindex: '-1' },
      },
      [dirty, label, close],
    );
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.actions.close(id);
    });
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // 中クリックの自動スクロールを抑止
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.actions.close(id);
      }
    });
    el.addEventListener('click', () => this.actions.activate(id));
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.actions.rename(id);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.actions.activate(id);
      new PopupMenu(this.actions.contextMenu(id), { label: 'タブ' }).showAt({ x: e.clientX, y: e.clientY });
    });
    el.addEventListener('keydown', (e) => this.onTabKey(e, id));
    el.addEventListener('dragstart', (e) => {
      this.dragId = id;
      el.classList.add('dragging');
      e.dataTransfer?.setData('application/x-editor-tab', id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      this.dragId = null;
      el.classList.remove('dragging');
      this.clearDropMarker();
    });
    return el;
  }

  private updateTab(el: HTMLElement, tab: TabMeta, active: boolean): void {
    const label = el.querySelector('.tab-label') as HTMLElement;
    if (label.textContent !== tab.name) label.textContent = tab.name;
    el.title = `${tab.name}${tab.modifiedSinceFile ? '（ファイル未書き出しの変更あり）' : ''}\nダブルクリックで名前変更、中クリックで閉じる`;
    el.classList.toggle('active', active);
    el.classList.toggle('modified', tab.modifiedSinceFile);
    el.setAttribute('aria-selected', String(active));
    el.setAttribute('tabindex', active ? '0' : '-1');
    el.setAttribute('aria-controls', 'editor-area');
    (el.querySelector('.tab-dirty') as HTMLElement).textContent = tab.modifiedSinceFile ? '●' : '';
  }

  private onTabKey(e: KeyboardEvent, id: string): void {
    const idx = this.store.indexOf(id);
    const tabs = this.store.all;
    let target: string | null = null;
    switch (e.key) {
      case 'ArrowRight':
        if (e.altKey && e.shiftKey) {
          this.actions.move(id, idx + 1);
          break;
        }
        target = tabs[(idx + 1) % tabs.length].id;
        break;
      case 'ArrowLeft':
        if (e.altKey && e.shiftKey) {
          this.actions.move(id, idx - 1);
          break;
        }
        target = tabs[(idx - 1 + tabs.length) % tabs.length].id;
        break;
      case 'Home':
        target = tabs[0].id;
        break;
      case 'End':
        target = tabs[tabs.length - 1].id;
        break;
      case 'Delete':
        this.actions.close(id);
        break;
      case 'F2':
        this.actions.rename(id);
        break;
      case 'Enter':
        this.actions.activate(id);
        (document.querySelector('.cm-content') as HTMLElement | null)?.focus();
        break;
      case 'ContextMenu': {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        new PopupMenu(this.actions.contextMenu(id), { label: 'タブ' }).showAt({ x: r.left, y: r.bottom });
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (target) {
      this.actions.activate(target);
      queueMicrotask(() => this.tabElement(target)?.focus());
    }
  }

  private dropIndex(e: DragEvent): number {
    const tabs = Array.from(this.list.children) as HTMLElement[];
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) return i;
    }
    return tabs.length;
  }

  private clearDropMarker(): void {
    for (const el of this.list.querySelectorAll('.drop-before, .drop-after')) {
      el.classList.remove('drop-before', 'drop-after');
    }
  }

  private onDragOver(e: DragEvent): void {
    if (!this.dragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    this.clearDropMarker();
    const idx = this.dropIndex(e);
    const tabs = this.list.children;
    if (idx < tabs.length) tabs[idx].classList.add('drop-before');
    else tabs[tabs.length - 1]?.classList.add('drop-after');
    // 端に近づいたら自動スクロール
    const r = this.list.getBoundingClientRect();
    if (e.clientX < r.left + 24) this.list.scrollLeft -= 12;
    else if (e.clientX > r.right - 24) this.list.scrollLeft += 12;
  }

  private onDrop(e: DragEvent): void {
    if (!this.dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const id = this.dragId;
    let idx = this.dropIndex(e);
    const from = this.store.indexOf(id);
    if (from < idx) idx--;
    this.clearDropMarker();
    this.dragId = null;
    this.actions.move(id, idx);
  }

  private showTabList(): void {
    const items: MenuItem[] = this.store.all.map((t) => ({
      label: `${t.modifiedSinceFile ? '● ' : ''}${t.name}`,
      checked: t.id === this.store.activeTabId,
      action: () => this.actions.activate(t.id),
    }));
    new PopupMenu(items, { label: 'タブ一覧' }).showAt(this.listButton);
  }
}
