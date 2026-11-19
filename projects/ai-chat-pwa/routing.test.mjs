import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel, inferTier } from './routing.js';

test('auto routing assigns quick, balanced, and complex prompts locally', () => {
  assert.equal(inferTier('Halo'), 'fast');
  assert.equal(inferTier('Apa arti routing otomatis?'), 'balanced');
  assert.equal(inferTier('Tolong audit kode ini'), 'deep');
});

test('a manually selected tier overrides the local prompt heuristic', () => {
  assert.equal(inferTier('Tolong audit kode ini', 'fast'), 'fast');
});

test('chooses the first configured model tagged for the requested tier', () => {
  const providers = [
    { name: 'One', models: [{ id: 'model-a', tiers: ['balanced'] }] },
    { name: 'Two', models: [{ id: 'model-b', tiers: ['deep'] }] }
  ];

  assert.equal(chooseModel(providers, 'audit', 'deep').model.id, 'model-b');
});

test('uses the exact provider and model selected manually', () => {
  const providers = [
    { id: 'one', name: 'One', models: [{ id: 'shared-model', tiers: ['balanced'] }] },
    { id: 'two', name: 'Two', models: [{ id: 'shared-model', tiers: ['deep'] }] }
  ];
  const result = chooseModel(providers, 'quick question', 'auto', {
    providerId: 'two',
    modelId: 'shared-model'
  });
  assert.equal(result.provider.name, 'Two');
  assert.equal(result.model.id, 'shared-model');
  assert.equal(result.tier, 'manual');
});

test('reports when a saved manual selection is no longer configured', () => {
  assert.throws(
    () => chooseModel([{ id: 'one', models: [{ id: 'available' }] }], 'question', 'auto', {
      providerId: 'one',
      modelId: 'removed'
    }),
    /Model yang dipilih tidak lagi tersedia/
  );
});

test('uses default or balanced model before falling back to the first model', () => {
  const providers = [{
    models: [
      { id: 'first', tiers: ['fast'] },
      { id: 'default', tiers: ['default'] }
    ]
  }];
  assert.equal(chooseModel(providers, 'x', 'deep').model.id, 'default');
  assert.throws(() => chooseModel([], 'x'), /Belum ada model/);
});
