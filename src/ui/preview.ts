import { h } from './dom';

type Renderer = (source: string) => string;

/**
 * Markdown プレビュー。
 * marked / DOMPurify は初回表示時に読み込む。生成した HTML は DOMPurify で無害化してから表示し、
 * さらに本番ビルドでは CSP（script-src 'self'）によりインラインスクリプトの実行を禁止している。
 */
export class MarkdownPreview {
  readonly el: HTMLElement;
  private readonly content: HTMLElement;
  private renderer: Renderer | null = null;
  private loading: Promise<Renderer> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSource: string | null = null;
  private token = 0;

  constructor() {
    this.content = h('article', { class: 'md-preview-content' });
    this.el = h(
      'aside',
      { class: 'md-preview', attrs: { 'aria-label': 'Markdown プレビュー', tabindex: '0' } },
      [this.content],
    );
    this.el.hidden = true;
    this.content.addEventListener('click', (e) => this.onClick(e));
  }

  private load(): Promise<Renderer> {
    if (this.renderer) return Promise.resolve(this.renderer);
    this.loading ??= import('../core/markdown').then((m) => {
      this.renderer = m.renderMarkdown;
      return m.renderMarkdown;
    });
    return this.loading;
  }

  /** プレビューを更新する（delay ms のデバウンス付き） */
  update(source: string, delay = 250): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.render(source);
    }, delay);
  }

  async render(source: string): Promise<void> {
    if (source === this.lastSource) return;
    const token = ++this.token;
    const render = await this.load();
    if (token !== this.token) return;
    this.lastSource = source;
    const html = render(source);
    const template = document.createElement('template');
    template.innerHTML = html; // DOMPurify で無害化済み
    this.content.replaceChildren(template.content);
  }

  /** 表示内容を破棄する（タブ切り替え時など） */
  reset(): void {
    this.lastSource = null;
    this.token++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.content.replaceChildren();
  }

  setVisible(visible: boolean): void {
    this.el.hidden = !visible;
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  /** エディタのスクロール位置（割合）に合わせる */
  syncScroll(ratio: number): void {
    const max = this.el.scrollHeight - this.el.clientHeight;
    if (max > 0) this.el.scrollTop = Math.round(max * ratio);
  }

  /** リンクは新しいタブで開く（ページ内リンクはプレビュー内でスクロール） */
  private onClick(e: MouseEvent): void {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    e.preventDefault();
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      const target = this.content.querySelector(`[id="${CSS.escape(id)}"]`);
      target?.scrollIntoView({ block: 'start' });
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
  }
}
