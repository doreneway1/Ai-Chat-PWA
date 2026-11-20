import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';

test('formats common assistant Markdown as readable HTML structures', () => {
  const html = marked.parse([
    '## Ringkasan',
    '',
    '**Status:** `berhasil`',
    '',
    '- Satu',
    '- Dua',
    '',
    '| File | Jenis |',
    '| --- | --- |',
    '| config | yaml |'
  ].join('\n'), { gfm: true, breaks: true });

  assert.match(html, /<h2>Ringkasan<\/h2>/);
  assert.match(html, /<strong>Status:<\/strong>/);
  assert.match(html, /<code>berhasil<\/code>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<table>/);
});
