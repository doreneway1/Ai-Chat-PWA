export const BACKUP_APP = 'dorenewAI';
export const BACKUP_VERSION = 2;
export const MAX_CUSTOM_TEMPLATES = 30;

export const BUILTIN_TEMPLATES = Object.freeze([
  { id: 'builtin-ringkas', name: 'Ringkas teks', content: 'Ringkas teks berikut menjadi poin-poin paling penting, tanpa menghilangkan angka dan keputusan penting:\n\n' },
  { id: 'builtin-sederhana', name: 'Jelaskan sederhana', content: 'Jelaskan topik berikut dengan bahasa sederhana, satu analogi, dan contoh praktis:\n\n' },
  { id: 'builtin-review-kode', name: 'Review kode', content: 'Review kode berikut. Prioritaskan bug, risiko keamanan, dan regresi; sebut baris/fungsi terkait lalu beri perbaikan konkret:\n\n' },
  { id: 'builtin-rencana', name: 'Buat rencana', content: 'Buat rencana bertahap untuk tujuan berikut, termasuk risiko, kebutuhan, dan langkah pertama yang bisa dilakukan hari ini:\n\n' },
  { id: 'builtin-tulisan', name: 'Perbaiki tulisan', content: 'Perbaiki tulisan berikut agar jelas, natural, dan enak dibaca. Pertahankan maksud aslinya lalu jelaskan perubahan besar secara singkat:\n\n' },
  { id: 'builtin-prokontra', name: 'Analisis pro/kontra', content: 'Analisis keputusan/topik berikut dengan pro, kontra, asumsi yang perlu diuji, dan rekomendasi bersyarat:\n\n' }
]);

export function normalizeCustomTemplates(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_CUSTOM_TEMPLATES).map((item, index) => ({
    id: typeof item?.id === 'string' && item.id ? item.id : `custom-${index}`,
    name: typeof item?.name === 'string' ? item.name.trim().slice(0, 60) : '',
    content: typeof item?.content === 'string' ? item.content.slice(0, 10_000) : ''
  })).filter(item => item.name && item.content);
}

export function buildBackup({ storage, conversations, exportedAt = Date.now() }) {
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
    throw new Error('Data pengaturan backup tidak valid.');
  }
  if (!Array.isArray(conversations)) throw new Error('Data percakapan backup tidak valid.');
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt,
    storage,
    conversations
  };
}

export function parseBackup(value) {
  const backup = typeof value === 'string' ? JSON.parse(value) : value;
  if (!backup || backup.app !== BACKUP_APP || ![1, 2].includes(backup.version)) {
    throw new Error('File ini bukan backup dorenewAI yang didukung.');
  }
  if (!backup.storage || typeof backup.storage !== 'object' || Array.isArray(backup.storage)) {
    throw new Error('Backup tidak memuat pengaturan yang valid.');
  }
  if (!Array.isArray(backup.conversations)) {
    throw new Error('Backup tidak memuat daftar percakapan yang valid.');
  }
  for (const conversation of backup.conversations) {
    if (!conversation || typeof conversation.id !== 'string' || !Array.isArray(conversation.messages)) {
      throw new Error('Backup memuat percakapan yang rusak.');
    }
  }
  const conversations = backup.conversations.map(conversation => ({
    ...conversation,
    title: typeof conversation.title === 'string' && conversation.title.trim()
      ? conversation.title
      : 'Percakapan'
  }));
  const storage = {};
  for (const [key, entry] of Object.entries(backup.storage)) {
    if (typeof key !== 'string' || !key.startsWith('orbit.')) continue;
    if (typeof entry === 'string') storage[key] = entry;
  }
  return { ...backup, storage, conversations };
}

export function planStorageRestore(backupStorage, storageKeys) {
  const toWrite = {};
  for (const [key, value] of Object.entries(backupStorage || {})) {
    if (storageKeys.includes(key) && typeof value === 'string') toWrite[key] = value;
  }
  const toRemove = storageKeys.filter(key => !(key in toWrite));
  const totalBytes = Object.entries(toWrite)
    .reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  return { toWrite, toRemove, totalBytes };
}

export function extractGeneratedImages(payload) {
  const items = Array.isArray(payload?.data) ? payload.data : [];
  return items.map(item => {
    if (typeof item?.url === 'string' && /^https:\/\//i.test(item.url)) {
      return { url: item.url, alt: 'Gambar hasil generate' };
    }
    if (typeof item?.b64_json === 'string' && item.b64_json.length > 100) {
      return { url: `data:image/png;base64,${item.b64_json}`, alt: 'Gambar hasil generate' };
    }
    return null;
  }).filter(Boolean).slice(0, 4);
}
