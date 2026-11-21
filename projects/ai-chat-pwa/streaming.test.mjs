import assert from 'node:assert/strict';
import test from 'node:test';
import { createSseParser, readChatResponse } from './streaming.js';

test('SSE parser menggabungkan delta yang terpotong di tengah baris', () => {
  const seen = [];
  const parser = createSseParser((delta, all) => seen.push([delta, all]));
  parser.push('data: {"model":"m1","choices":[{"delta":{"content":"Halo "}}]}\n');
  parser.push('\ndata: {"choices":[{"delta":{"content":"dunia"}}]}\n\n');
  parser.push('data: [DONE]\n\n');
  const result = parser.finish();
  assert.equal(result.content, 'Halo dunia');
  assert.equal(result.model, 'm1');
  assert.deepEqual(seen, [['Halo ', 'Halo '], ['dunia', 'Halo dunia']]);
});

test('readChatResponse membaca JSON non-stream sebagai fallback', async () => {
  const response = new Response(JSON.stringify({
    model: 'json-model',
    choices: [{ message: { content: 'Jawaban JSON' } }]
  }), { headers: { 'Content-Type': 'application/json' } });
  const result = await readChatResponse(response);
  assert.equal(result.content, 'Jawaban JSON');
  assert.equal(result.model, 'json-model');
});

test('readChatResponse melempar detail error provider', async () => {
  const response = new Response(JSON.stringify({ error: { message: 'kuota habis' } }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' }
  });
  await assert.rejects(() => readChatResponse(response), /429: kuota habis/);
});
