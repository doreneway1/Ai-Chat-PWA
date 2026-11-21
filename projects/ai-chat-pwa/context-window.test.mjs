import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApiMessages } from './context-window.js';

const systemMessage = { role: 'system', content: 'Sistem' };

function conversationWith(count, extra = {}) {
  const messages = [];
  for (let i = 0; i < count; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `pesan ${i}`, createdAt: i });
  }
  return { messages, ...extra };
}

test('memotong riwayat ke maxMessages terakhir dan menaruh system message di depan', () => {
  const result = buildApiMessages(conversationWith(10), { systemMessage, maxMessages: 4 });
  assert.equal(result[0], systemMessage);
  assert.equal(result.length, 5);
  assert.equal(result.at(-1).content, 'pesan 9');
});

test('menghormati summaryThrough', () => {
  const result = buildApiMessages(
    conversationWith(6, { summary: 'ringkasan', summaryThrough: 4 }),
    { systemMessage, maxMessages: 38 }
  );
  assert.deepEqual(result.slice(1).map(message => message.content), ['pesan 4', 'pesan 5']);
});

test('gambar hanya dikirim pada pesan user terakhir', () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } };
  const result = buildApiMessages({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'lama' }, image], createdAt: 1 },
      { role: 'assistant', content: 'balasan', createdAt: 2 },
      { role: 'user', content: [{ type: 'text', text: 'baru' }, image], createdAt: 3 }
    ]
  }, { systemMessage, maxMessages: 38 });
  assert.deepEqual(result[1].content, [{ type: 'text', text: 'lama' }]);
  assert.equal(result[3].content.length, 2);
});

test('blok konteks digabung ke part teks pertama sehingga jumlah parts tidak bertambah', () => {
  const result = buildApiMessages({
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'baca ini' }],
      createdAt: 1,
      linkSources: [{ url: 'https://contoh.test', title: 'Contoh', text: 'isi tautan', status: 'ok' }]
    }]
  }, { systemMessage, maxMessages: 38 });
  assert.equal(result[1].content.length, 1);
  assert.match(result[1].content[0].text, /isi tautan/);
});

test('anggaran byte memangkas pesan terlama', () => {
  const result = buildApiMessages(conversationWith(5), { systemMessage, maxMessages: 38, maxBytes: 200 });
  assert.ok(result.length < 6);
  assert.equal(result.at(-1).content, 'pesan 4');
});
