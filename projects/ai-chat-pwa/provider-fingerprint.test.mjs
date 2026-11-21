import assert from 'node:assert/strict';
import test from 'node:test';
import { providerFingerprint, rebuildTestFingerprints } from './provider-fingerprint.js';

const provider = {
  id: 'p1',
  apiBase: 'https://ai.ipeenk.com/v1',
  apiKey: 'sk-plaintext',
  models: [{ id: 'm1', tiers: ['balanced'] }]
};

test('fingerprint berubah bila key, base URL, model, atau proxy berubah', () => {
  const base = providerFingerprint(provider, 'https://worker.example');
  assert.notEqual(providerFingerprint({ ...provider, apiKey: 'sk-lain' }, 'https://worker.example'), base);
  assert.notEqual(providerFingerprint({ ...provider, apiBase: 'https://kunciai.id/v1' }, 'https://worker.example'), base);
  assert.notEqual(providerFingerprint({ ...provider, models: [{ id: 'm2', tiers: ['deep'] }] }, 'https://worker.example'), base);
  assert.notEqual(providerFingerprint(provider, 'https://worker-lain.example'), base);
  assert.equal(providerFingerprint(provider, 'https://worker.example'), base);
});

test('rebuild hanya memuat provider yang sudah dites', () => {
  const map = rebuildTestFingerprints([
    { ...provider, tested: true },
    { ...provider, id: 'p2', tested: false }
  ], 'https://worker.example');
  assert.equal(map.size, 1);
  assert.equal(map.get('p1'), providerFingerprint(provider, 'https://worker.example'));
});

test('fingerprint ciphertext berbeda dengan plaintext sehingga wajib dibangun ulang setelah unlock (regresi F1)', () => {
  const locked = providerFingerprint({ ...provider, apiKey: 'vault:v1:c2FsdA==:aXY=:Y2lwaGVy' }, 'https://worker.example');
  const unlocked = providerFingerprint(provider, 'https://worker.example');
  assert.notEqual(locked, unlocked);
  const rebuilt = rebuildTestFingerprints([{ ...provider, tested: true }], 'https://worker.example');
  assert.equal(rebuilt.get('p1'), unlocked);
});
