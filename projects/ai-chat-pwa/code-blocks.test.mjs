import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceCodeBlock, splitCodeBlocks } from './code-blocks.js';

test('splits prose and labeled YAML, JSON, and shell code blocks', () => {
  const content = [
    'Contoh konfigurasi:',
    '```yaml',
    'name: orbit',
    '```',
    'Perintah:',
    '```bash',
    'npm test',
    '```'
  ].join('\n');
  const parts = splitCodeBlocks(content);
  assert.deepEqual(parts.filter(part => part.type === 'code').map(({ language, value }) => ({ language, value })), [
    { language: 'yaml', value: 'name: orbit\n' },
    { language: 'bash', value: 'npm test\n' }
  ]);
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[2].type, 'text');
});

test('replaces only the selected fenced code content and preserves its formatting', () => {
  const content = '```json\n{"ok":true}\n```\nDone';
  const [block] = splitCodeBlocks(content).filter(part => part.type === 'code');
  assert.equal(replaceCodeBlock(content, block, '{\n  "ok": false\n}\n'), '```json\n{\n  "ok": false\n}\n```\nDone');
});

test('leaves unfenced text unchanged and rejects invalid replacement ranges', () => {
  assert.deepEqual(splitCodeBlocks('plain text'), [{ type: 'text', value: 'plain text' }]);
  assert.throws(() => replaceCodeBlock('abc', { start: 0, end: 9 }, ''), /tidak valid/);
});

test('handles empty blocks and code that matches its language label', () => {
  const parts = splitCodeBlocks('```yaml\nyaml\n```\n```json\n```');
  assert.deepEqual(parts.filter(part => part.type === 'code').map(part => part.value), ['yaml\n', '']);
});
