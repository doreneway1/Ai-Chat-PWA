import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBackup,
  extractGeneratedImages,
  normalizeCustomTemplates,
  parseBackup,
  planStorageRestore
} from './data-tools.js';
import { decryptSecret, encryptSecret, isVaultCiphertext } from './vault.js';

test('backup dibuild dan divalidasi, storage non-orbit dibuang saat parse', () => {
  const backup = buildBackup({
    storage: { 'orbit.settings.v1': '{}' },
    conversations: [{ id: 'c1', messages: [] }]
  });
  const parsed = parseBackup({ ...backup, storage: { ...backup.storage, 'lain.x': 'x' } });
  assert.equal(parsed.app, 'dorenewAI');
  assert.deepEqual(Object.keys(parsed.storage), ['orbit.settings.v1']);
  assert.throws(() => parseBackup({ app: 'lain', version: 2, storage: {}, conversations: [] }), /bukan backup/);
});

test('template kustom dinormalkan dan gambar hasil generate diekstrak', () => {
  assert.equal(normalizeCustomTemplates([{ name: ' A ', content: 'Isi' }, { name: '', content: 'x' }]).length, 1);
  const images = extractGeneratedImages({ data: [
    { url: 'https://cdn.example/a.png' },
    { b64_json: 'x'.repeat(101) },
    { url: 'http://tidak-aman.example/a.png' }
  ] });
  assert.equal(images.length, 2);
  assert.match(images[1].url, /^data:image\/png;base64,/);
});

test('vault mengenkripsi dan membuka secret dengan PIN yang benar saja', async () => {
  const cipher = await encryptSecret('sk-rahasia-123', '123456');
  assert.equal(isVaultCiphertext(cipher), true);
  assert.equal(cipher.includes('sk-rahasia'), false);
  assert.equal(await decryptSecret(cipher, '123456'), 'sk-rahasia-123');
  await assert.rejects(() => decryptSecret(cipher, '654321'), /PIN salah/);
});

test('planStorageRestore hanya menulis key yang dikenal dan menghitung ukuran', () => {
  const plan = planStorageRestore(
    { 'orbit.settings.v1': '{"a":1}', 'lain.x': 'x', 'orbit.modelSelection.v1': 'auto' },
    ['orbit.settings.v1', 'orbit.modelSelection.v1', 'orbit.aiLevel.v1']
  );
  assert.deepEqual(Object.keys(plan.toWrite).sort(), ['orbit.modelSelection.v1', 'orbit.settings.v1']);
  assert.deepEqual(plan.toRemove, ['orbit.aiLevel.v1']);
  assert.equal(plan.totalBytes, 'orbit.settings.v1'.length + '{"a":1}'.length + 'orbit.modelSelection.v1'.length + 'auto'.length);
});

test('parseBackup memberi judul default pada percakapan tanpa judul', () => {
  const parsed = parseBackup(buildBackup({
    storage: {},
    conversations: [
      { id: 'c1', messages: [] },
      { id: 'c2', title: '  ', messages: [] },
      { id: 'c3', title: 'Asli', messages: [] }
    ]
  }));
  assert.deepEqual(parsed.conversations.map(item => item.title), ['Percakapan', 'Percakapan', 'Asli']);
});

test('decryptSecret menolak ciphertext brankas yang bagiannya kosong', async () => {
  await assert.rejects(() => decryptSecret('vault:v1:c2FsdA==:aXY=:', '123456'), /Format brankas/);
});
