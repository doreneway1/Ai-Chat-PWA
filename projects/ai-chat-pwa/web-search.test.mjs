import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchContextBlock, fetchWebSearch } from './web-search.js';

test('fetchWebSearch menormalkan hasil Worker', async () => {
  const fetchImpl = async (url, options) => {
    assert.match(url, /\/api\/search$/);
    assert.equal(JSON.parse(options.body).query, 'berita AI');
    return new Response(JSON.stringify({ results: [
      { title: 'Judul', url: 'https://example.com/a', description: 'Cuplikan', age: '2 jam' },
      { title: '', url: 'https://example.com/b', description: '' }
    ] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const results = await fetchWebSearch('https://worker.example', 'berita AI', 'provider-key', 'brave-key', fetchImpl);
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, 'search');
  const block = buildSearchContextBlock(results);
  assert.match(block, /HASIL PENCARIAN WEB/);
  assert.match(block, /example\.com\/a/);
});

test('fetchWebSearch menolak bila Brave key belum diatur', async () => {
  await assert.rejects(
    () => fetchWebSearch('https://worker.example', 'tes', 'key', ''),
    /Brave Search API key belum diatur/
  );
});
