import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSummarySource,
  cleanGeneratedTitle,
  estimateMessageTokens,
  normalizeGenerationSettings,
  shouldSummarizeConversation
} from './generation.js';
import { chooseModelCandidates } from './routing.js';

const providers = [
  { id: 'p1', name: 'Satu', models: [{ id: 'fast-1', tiers: ['fast'] }, { id: 'deep-1', tiers: ['deep'] }] },
  { id: 'p2', name: 'Dua', models: [{ id: 'bal-2', tiers: ['balanced', 'default'] }, { id: 'deep-2', tiers: ['deep'] }] }
];

test('normalizeGenerationSettings membatasi parameter ke rentang aman', () => {
  assert.deepEqual(normalizeGenerationSettings({ temperature: 9, maxTokens: 99999, webSearch: 1 }), {
    temperature: 2,
    maxTokens: 16384,
    webSearch: true,
    autoSummary: true
  });
  assert.equal(normalizeGenerationSettings({}).maxTokens, 4096);
});

test('chooseModelCandidates mengurutkan tier lalu provider lain untuk failover', () => {
  const candidates = chooseModelCandidates(providers, 'tolong audit kode ini', 'auto', null, 4);
  assert.equal(candidates[0].model.id, 'deep-1');
  assert.ok(candidates.some(item => item.model.id === 'deep-2'));
  assert.equal(new Set(candidates.map(item => `${item.provider.id}:${item.model.id}`)).size, candidates.length);
});

test('manual selection hanya failover ke model yang sama di provider lain', () => {
  const candidates = chooseModelCandidates([
    ...providers,
    { id: 'p3', name: 'Tiga', models: [{ id: 'deep-1', tiers: ['deep'] }] }
  ], 'halo', 'auto', { providerId: 'p1', modelId: 'deep-1' }, 4);
  assert.deepEqual(candidates.map(item => item.provider.id), ['p1', 'p3']);
});

test('judul otomatis dibersihkan dan ringkasan hanya memicu untuk chat panjang', () => {
  assert.equal(cleanGeneratedTitle('"Rencana Upgrade Aplikasi."'), 'Rencana Upgrade Aplikasi');
  const conversation = { summaryThrough: 0, messages: Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `Pesan ${i} ` + 'konteks penting '.repeat(30)
  })) };
  assert.equal(shouldSummarizeConversation(conversation), true);
  const source = buildSummarySource(conversation);
  assert.equal(source.batchCount, 24);
  assert.equal(source.nextThrough, 24);
  assert.ok(estimateMessageTokens(conversation.messages).tokens > 1000);
});
