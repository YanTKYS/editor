import { LanguageDescription } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { EditorMode } from '../core/types';

/**
 * 言語サポートは初回利用時に読み込む（初期表示を軽くするため、ビルド時に別チャンクへ分割される）。
 */
const loaders: Record<EditorMode, () => Promise<Extension>> = {
  plaintext: async () => [],
  markdown: async () => {
    const { markdown, markdownLanguage } = await import('@codemirror/lang-markdown');
    return markdown({ base: markdownLanguage, codeLanguages: markdownCodeLanguages });
  },
  json: async () => (await import('@codemirror/lang-json')).json(),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  typescript: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  html: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
};

/** Markdown のコードブロック内で利用する言語 */
const markdownCodeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: 'JavaScript',
    alias: ['js', 'javascript', 'jsx', 'mjs'],
    load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: 'TypeScript',
    alias: ['ts', 'typescript', 'tsx'],
    load: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  }),
  LanguageDescription.of({
    name: 'JSON',
    alias: ['json', 'jsonc'],
    load: async () => (await import('@codemirror/lang-json')).json(),
  }),
  LanguageDescription.of({
    name: 'HTML',
    alias: ['html', 'htm'],
    load: async () => (await import('@codemirror/lang-html')).html(),
  }),
  LanguageDescription.of({
    name: 'CSS',
    alias: ['css'],
    load: async () => (await import('@codemirror/lang-css')).css(),
  }),
  LanguageDescription.of({
    name: 'XML',
    alias: ['xml', 'svg'],
    load: async () => (await import('@codemirror/lang-xml')).xml(),
  }),
];

const loaded = new Map<EditorMode, Extension>([['plaintext', []]]);
const pending = new Map<EditorMode, Promise<Extension>>();

/** 読み込み済みの言語拡張（未読み込みなら undefined） */
export function getLoadedLanguage(mode: EditorMode): Extension | undefined {
  return loaded.get(mode);
}

/** 言語拡張を読み込む（読み込みに失敗した場合は Plain Text として扱う） */
export function loadLanguage(mode: EditorMode): Promise<Extension> {
  const done = loaded.get(mode);
  if (done) return Promise.resolve(done);
  let p = pending.get(mode);
  if (!p) {
    p = loaders[mode]()
      .then((ext) => {
        loaded.set(mode, ext);
        return ext;
      })
      .catch((e: unknown) => {
        console.error(`言語サポート (${mode}) の読み込みに失敗しました`, e);
        pending.delete(mode);
        return [] as Extension;
      });
    pending.set(mode, p);
  }
  return p;
}
