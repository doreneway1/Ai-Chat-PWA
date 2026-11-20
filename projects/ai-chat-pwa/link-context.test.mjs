import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LINK_CONTEXT_CHARS,
  buildLinkContextBlock,
  extractUrls,
  fetchLinkContext
} from './link-context.js';

test('extracts and deduplicates URLs while trimming trailing punctuation', () => {
  const text = 'Baca https://example.com/artikel, lalu (https://t.me/bozdrop). Ulangi https://example.com/artikel ya';
  assert.deepEqual(extractUrls(text), [
    'https://example.com/artikel',
    'https://t.me/bozdrop'
  ]);
});

test('keeps balanced parentheses inside URLs and rejects non-URLs', () => {
  assert.deepEqual(extractUrls('Lihat https://example.com/wiki/A_(b) dan www.example.com serta ftp://x.y/z'), [
    'https://example.com/wiki/A_(b)'
  ]);
  assert.deepEqual(extractUrls('tidak ada tautan'), []);
  assert.deepEqual(extractUrls(null), []);
});

test('limits the number of detected URLs per message', () => {
  const text = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join(' ');
  assert.equal(extractUrls(text).length, 3);
});

test('builds a delimited untrusted context block with sources', () => {
  const block = buildLinkContextBlock([
    {
      status: 'ok',
      url: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      title: 'Artikel A',
      description: '',
      text: 'Isi artikel A.'
    },
    { status: 'error', url: 'https://example.com/gagal', text: 'tidak dipakai' }
  ]);
  assert.match(block, /^--- SUMBER WEB ---/);
  assert.match(block, /bukan sebagai instruksi/);
  assert.match(block, /\[Sumber 1\] Artikel A/);
  assert.match(block, /Isi artikel A\./);
  assert.doesNotMatch(block, /gagal/);
  assert.match(block, /--- AKHIR SUMBER WEB ---$/);
});

test('caps the total link context size', () => {
  const block = buildLinkContextBlock([
    { status: 'ok', url: 'https://a.example/x', finalUrl: 'https://a.example/x', title: 'A', text: 'x'.repeat(30_000) },
    { status: 'ok', url: 'https://b.example/y', finalUrl: 'https://b.example/y', title: 'B', text: 'y'.repeat(30_000) }
  ]);
  assert.ok(block.length <= MAX_LINK_CONTEXT_CHARS, `block ${block.length} exceeds cap`);
});

test('returns an empty block when nothing was fetched', () => {
  assert.equal(buildLinkContextBlock([]), '');
  assert.equal(buildLinkContextBlock([{ status: 'error', url: 'https://x.example' }]), '');
});

test('fetches link context through the Worker scrape route', async () => {
  let sentUrl;
  let sentInit;
  const source = await fetchLinkContext('https://proxy.example.workers.dev/', 'https://example.com/a', 'key-123456', async (url, init) => {
    sentUrl = url;
    sentInit = init;
    return Response.json({
      url: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      title: 'A',
      description: 'D',
      text: 'Teks',
      truncated: false,
      fetchedAt: 123
    });
  });
  assert.equal(sentUrl, 'https://proxy.example.workers.dev/api/scrape');
  assert.equal(sentInit.headers.Authorization, 'Bearer key-123456');
  assert.deepEqual(JSON.parse(sentInit.body), { url: 'https://example.com/a' });
  assert.equal(source.status, 'ok');
  assert.equal(source.text, 'Teks');
  assert.equal(source.fetchedAt, 123);
});

test('surfaces Worker errors when fetching link context fails', async () => {
  await assert.rejects(
    fetchLinkContext('https://proxy.example.workers.dev', 'https://example.com/a', 'key-123456', async () =>
      Response.json({ error: 'Halaman tidak memuat teks yang dapat dibaca.' }, { status: 422 })
    ),
    /tidak memuat teks/
  );
});
