import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import type { ThemeName } from '../core/types';

/**
 * エディタの配色。色は CSS 変数（styles/main.css）で定義し、
 * ここでは CodeMirror の構造に対する割り当てとシンタックスハイライトのみを行う。
 */
const baseTheme = (dark: boolean) =>
  EditorView.theme(
    {
      '&': {
        color: 'var(--editor-fg)',
        backgroundColor: 'var(--editor-bg)',
        height: '100%',
      },
      '.cm-content': {
        caretColor: 'var(--editor-caret)',
        fontFamily: 'var(--editor-font)',
      },
      '.cm-scroller': {
        fontFamily: 'var(--editor-font)',
        lineHeight: '1.5',
      },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--editor-caret)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: 'var(--editor-selection)' },
      '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
      '.cm-gutters': {
        backgroundColor: 'var(--editor-gutter-bg)',
        color: 'var(--editor-gutter-fg)',
        borderRight: '1px solid var(--border)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--editor-active-line-gutter)',
        color: 'var(--editor-fg)',
      },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'var(--editor-bracket-bg)',
        outline: '1px solid var(--editor-bracket-border)',
      },
      '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
        backgroundColor: 'var(--editor-bad-bracket-bg)',
      },
      '.cm-searchMatch': {
        backgroundColor: 'var(--editor-search-match)',
        outline: '1px solid var(--editor-search-match-border)',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'var(--editor-search-current)',
      },
      '.cm-selectionMatch': { backgroundColor: 'var(--editor-selection-match)' },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--editor-gutter-bg)',
        border: '1px solid var(--border)',
        color: 'var(--editor-gutter-fg)',
      },
      '.cm-eolMarker': {
        color: 'var(--editor-whitespace)',
        fontSize: '0.7em',
        marginLeft: '2px',
        padding: '0 2px',
        border: '1px solid var(--editor-whitespace)',
        borderRadius: '2px',
        verticalAlign: 'middle',
        userSelect: 'none',
        pointerEvents: 'none',
      },
      '.cm-panels': { backgroundColor: 'var(--panel-bg)', color: 'var(--fg)' },
      '.cm-tooltip': {
        backgroundColor: 'var(--panel-bg)',
        color: 'var(--fg)',
        border: '1px solid var(--border)',
      },
    },
    { dark },
  );

const lightTheme: Extension = [baseTheme(false), syntaxHighlighting(defaultHighlightStyle, { fallback: true })];
const darkTheme: Extension = [baseTheme(true), syntaxHighlighting(oneDarkHighlightStyle, { fallback: true })];

export function themeExtension(theme: ThemeName): Extension {
  return theme === 'dark' ? darkTheme : lightTheme;
}
