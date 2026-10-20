import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/core/markdown';

describe('Markdown プレビューの無害化', () => {
  it('Markdown を HTML に変換する', () => {
    const html = renderMarkdown('# 見出し\n\n**太字** と [リンク](https://example.com)\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<h1>見出し</h1>');
    expect(html).toContain('<strong>太字</strong>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<table>');
  });

  it.each([
    ['<script>alert(1)</script>', /<script/i],
    ['<img src="x" onerror="alert(1)">', /onerror/i],
    ['[x](javascript:alert(1))', /javascript:/i],
    ['<a href="JaVaScRiPt:alert(1)">x</a>', /javascript:/i],
    ['<iframe src="https://example.com"></iframe>', /<iframe/i],
    ['<div style="position:fixed;inset:0">x</div>', /style=/i],
    ['<svg><script>alert(1)</script></svg>', /<script|<svg/i],
    ['<form action="https://evil.example"><input name="p"></form>', /<form|<input/i],
    ['<a href="data:text/html,<script>alert(1)</script>">x</a>', /data:text/i],
    ['<object data="x"></object><embed src="x">', /<object|<embed/i],
    ['<style>body{display:none}</style>', /<style/i],
  ])('%s を除去する', (src, pattern) => {
    expect(renderMarkdown(src)).not.toMatch(pattern);
  });

  it('画像の data URL（ラスター画像）は許可する', () => {
    expect(renderMarkdown('![a](data:image/png;base64,AAAA)')).toContain('src="data:image/png;base64,AAAA"');
  });
});
