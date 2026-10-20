import { describe, expect, it } from 'vitest';
import { detectMode, fileExtension } from '../../src/core/modes';

describe('編集モードの判定', () => {
  it.each([
    ['memo.txt', 'plaintext'],
    ['README.md', 'markdown'],
    ['data.JSON', 'json'],
    ['app.js', 'javascript'],
    ['app.mjs', 'javascript'],
    ['main.ts', 'typescript'],
    ['index.html', 'html'],
    ['style.css', 'css'],
    ['web.config', 'xml'],
    ['layout.xml', 'xml'],
    ['新規 1', 'plaintext'],
    ['unknown.xyz', 'plaintext'],
  ])('%s → %s', (name, mode) => {
    expect(detectMode(name)).toBe(mode);
  });

  it('拡張子を取り出す', () => {
    expect(fileExtension('a.b.TXT')).toBe('txt');
    expect(fileExtension('.gitignore')).toBe('');
    expect(fileExtension('noext')).toBe('');
    expect(fileExtension('dir.d/file')).toBe('');
  });
});
