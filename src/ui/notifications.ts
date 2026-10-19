import { h } from './dom';

export interface BannerAction {
  label: string;
  action: () => void;
  primary?: boolean;
}

/**
 * 通知表示。
 * - toast: 数秒で消える軽い通知
 * - banner: 利用者の対応が必要な状態（保存失敗・競合など）。解消されるまで表示し続ける
 */
export class Notifications {
  readonly bannerArea: HTMLElement;
  readonly toastArea: HTMLElement;
  private banners = new Map<string, HTMLElement>();

  constructor() {
    this.bannerArea = h('div', { class: 'banner-area' });
    this.toastArea = h('div', {
      class: 'toast-area',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
  }

  toast(message: string, kind: 'info' | 'success' | 'warning' | 'error' = 'info', timeout = 3500): void {
    const el = h('div', { class: `toast toast-${kind}`, text: message });
    this.toastArea.append(el);
    while (this.toastArea.children.length > 4) this.toastArea.firstElementChild?.remove();
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 300);
    }, timeout);
  }

  /** 同じ id のバナーは置き換える */
  banner(
    id: string,
    message: string,
    kind: 'info' | 'warning' | 'error',
    actions: BannerAction[] = [],
    dismissible = false,
  ): void {
    this.dismiss(id);
    const buttons = actions.map((a) =>
      h('button', {
        class: `btn btn-small${a.primary ? ' btn-primary' : ''}`,
        text: a.label,
        type: 'button',
        on: { click: () => a.action() },
      }),
    );
    if (dismissible) {
      buttons.push(
        h('button', {
          class: 'btn btn-small btn-plain',
          text: '×',
          type: 'button',
          title: '閉じる',
          attrs: { 'aria-label': '通知を閉じる' },
          on: { click: () => this.dismiss(id) },
        }),
      );
    }
    const el = h(
      'div',
      {
        class: `banner banner-${kind}`,
        dataset: { banner: id },
        attrs: { role: kind === 'error' ? 'alert' : 'status' },
      },
      [h('span', { class: 'banner-message', text: message }), h('span', { class: 'banner-actions' }, buttons)],
    );
    this.banners.set(id, el);
    this.bannerArea.append(el);
  }

  dismiss(id: string): void {
    this.banners.get(id)?.remove();
    this.banners.delete(id);
  }

  has(id: string): boolean {
    return this.banners.has(id);
  }
}
