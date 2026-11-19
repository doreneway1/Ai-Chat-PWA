import { chooseModel } from './routing.js';

const SETTINGS_KEY = 'orbit.settings.v1';
const DB_NAME = 'orbit-local-chat';
const DB_VERSION = 1;
const MAX_CONTEXT_MESSAGES = 39;
const MAX_API_CONTEXT_BYTES = 7_500_000;
const MAX_PROVIDERS = 10;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGES_BYTES = 5 * 1024 * 1024;
const MAX_EXTRACTED_TEXT = 100_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_MODELS_PER_PROVIDER = 100;
const MODEL_TIERS = new Set(['fast', 'balanced', 'deep', 'default']);
const SYSTEM_PROMPT =
  'Jawab secara lugas, relevan, dan sesuai bahasa serta format yang diminta pengguna. ' +
  'Ikuti instruksi pengguna untuk permintaan yang aman, hindari disclaimer atau penolakan yang tidak perlu, ' +
  'dan jelaskan singkat bila ada bagian yang tidak dapat dipenuhi.';

const elements = {
  conversationList: document.querySelector('#conversationList'),
  welcome: document.querySelector('#welcome'),
  chatArea: document.querySelector('.chat-area'),
  messages: document.querySelector('#messages'),
  chatForm: document.querySelector('#chatForm'),
  messageInput: document.querySelector('#messageInput'),
  sendButton: document.querySelector('#sendButton'),
  settingsDialog: document.querySelector('#settingsDialog'),
  settingsForm: document.querySelector('#settingsForm'),
  settingsError: document.querySelector('#settingsError'),
  proxyUrl: document.querySelector('#proxyUrl'),
  providerList: document.querySelector('#providerList'),
  addProvider: document.querySelector('#addProvider'),
  connectionStatus: document.querySelector('#connectionStatus'),
  saveSettings: document.querySelector('#saveSettings'),
  fileInput: document.querySelector('#fileInput'),
  attachButton: document.querySelector('#attachButton'),
  attachmentList: document.querySelector('#attachmentList'),
  aiLevel: document.querySelector('#aiLevel'),
  routeLabel: document.querySelector('#routeLabel'),
  toast: document.querySelector('#toast'),
  sidebar: document.querySelector('#sidebar'),
  sidebarBackdrop: document.querySelector('#sidebarBackdrop')
};

let db;
let conversations = [];
let currentConversationId = null;
let sending = false;
let toastTimer;
let selectedFiles = [];
let settings = readSettings();
let providerTestFingerprints = new Map(
  settings.providers
    .filter(provider => provider.tested)
    .map(provider => [provider.id, providerFingerprint(provider, settings.proxyUrl)])
);

function readSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    let providers = Array.isArray(saved.providers)
      ? saved.providers.slice(0, MAX_PROVIDERS)
      : [];
    if (!providers.length && saved.apiBase && saved.apiKey && (saved.modelAlias || saved.autoModel)) {
      providers = [{
        id: 'migrated-provider',
        name: 'Provider 1',
        apiBase: saved.apiBase,
        apiKey: saved.apiKey,
        models: [{
          id: saved.modelAlias || saved.autoModel,
          tiers: ['fast', 'balanced', 'deep', 'default']
        }],
        tested: false
      }];
    }
    return {
      proxyUrl: saved.proxyUrl || '',
      providers,
      responseStyle: saved.responseStyle || 'direct'
    };
  } catch (error) {
    showToast(`Pengaturan lokal tidak dapat dibaca: ${error.message}`);
    return { proxyUrl: '', providers: [], responseStyle: 'direct' };
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('conversations')) {
        database.createObjectStore('conversations', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB tidak tersedia'));
    request.onblocked = () => reject(new Error('Database lokal sedang sibuk di tab lain'));
  });
}

function withConversationStore(mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('conversations', mode);
    const request = operation(transaction.objectStore('conversations'));
    let result;
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => reject(request.error || new Error('Gagal mengakses riwayat lokal'));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('Gagal menyimpan riwayat lokal'));
    transaction.onabort = () => reject(transaction.error || new Error('Perubahan riwayat lokal dibatalkan'));
  });
}

async function loadConversations() {
  conversations = (await withConversationStore('readonly', store => store.getAll()))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  renderConversationList();
}

async function saveConversation(conversation) {
  await withConversationStore('readwrite', store => store.put(conversation));
  const index = conversations.findIndex(item => item.id === conversation.id);
  if (index >= 0) conversations[index] = conversation;
  else conversations.push(conversation);
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  renderConversationList();
}

async function deleteConversation(id) {
  await withConversationStore('readwrite', store => store.delete(id));
  conversations = conversations.filter(item => item.id !== id);
  if (currentConversationId === id) currentConversationId = null;
  renderConversationList();
  renderMessages();
}

function renderConversationList() {
  elements.conversationList.replaceChildren();
  for (const conversation of conversations) {
    const item = document.createElement('div');
    item.className = `conversation-item${conversation.id === currentConversationId ? ' active' : ''}`;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', conversation.title);

    const title = document.createElement('span');
    title.className = 'conversation-title';
    title.textContent = conversation.title;
    item.append(title);
    item.addEventListener('click', () => selectConversation(conversation.id));
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectConversation(conversation.id);
      }
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete-conversation';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Hapus ${conversation.title}`);
    remove.addEventListener('click', async event => {
      event.stopPropagation();
      try {
        await deleteConversation(conversation.id);
      } catch (error) {
        showToast(`Riwayat gagal dihapus: ${error.message}`);
      }
    });
    item.append(remove);
    elements.conversationList.append(item);
  }
}

function selectConversation(id) {
  currentConversationId = id;
  renderConversationList();
  renderMessages();
  closeSidebar();
}

function activeConversation() {
  return conversations.find(item => item.id === currentConversationId) || null;
}

function createConversation() {
  currentConversationId = null;
  renderConversationList();
  renderMessages();
  elements.messageInput.focus();
  closeSidebar();
}

function renderMessages() {
  const conversation = activeConversation();
  elements.messages.replaceChildren();
  const hasMessages = Boolean(conversation?.messages.length);
  elements.welcome.classList.toggle('hidden', hasMessages);
  elements.messages.classList.toggle('visible', hasMessages);
  if (!hasMessages) return;

  for (const message of conversation.messages) {
    elements.messages.append(createMessageElement(message));
  }
  elements.chatArea.scrollTop = elements.chatArea.scrollHeight;
}

function createMessageElement(message) {
  const wrapper = document.createElement('article');
  wrapper.className = `message ${message.role === 'user' ? 'user' : ''}${message.error ? ' error' : ''}`;
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = message.role === 'user' ? 'YOU' : '✳';
  const body = document.createElement('div');
  body.className = 'message-body';
  const role = document.createElement('p');
  role.className = 'message-role';
  role.textContent = message.role === 'user' ? 'Kamu' : 'Orbit';
  const content = document.createElement('div');
  content.className = 'message-content';
  if (typeof message.content === 'string') {
    content.textContent = message.content;
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') {
        const text = document.createElement('div');
        text.textContent = part.text;
        content.append(text);
      } else if (part.type === 'image_url') {
        const image = document.createElement('img');
        image.className = 'message-image';
        image.alt = 'Lampiran gambar';
        image.src = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
        content.append(image);
      }
    }
  }
  body.append(role, content);
  if (message.model) {
    const actualModel = document.createElement('div');
    actualModel.className = 'message-model';
    actualModel.textContent = `ROUTED VIA ${message.model}`;
    body.append(actualModel);
  }
  wrapper.append(avatar, body);
  return wrapper;
}

function showTyping() {
  const wrapper = document.createElement('article');
  wrapper.className = 'message';
  wrapper.id = 'typingIndicator';
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = '✳';
  const body = document.createElement('div');
  body.className = 'message-body';
  const role = document.createElement('p');
  role.className = 'message-role';
  role.textContent = 'Orbit';
  const dots = document.createElement('div');
  dots.className = 'typing-indicator';
  dots.setAttribute('aria-label', 'Sedang berpikir');
  for (let i = 0; i < 3; i += 1) dots.append(document.createElement('span'));
  body.append(role, dots);
  wrapper.append(avatar, body);
  elements.messages.append(wrapper);
  elements.chatArea.scrollTop = elements.chatArea.scrollHeight;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 4000);
}

function extensionOf(name) {
  return name.split('.').pop()?.toLowerCase() || '';
}

function validateZipArchive(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('Arsip Office tidak valid.');

  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntries = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount > 2_000 ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('Format arsip Office tidak didukung atau terlalu besar.');
  }

  let offset = centralOffset;
  let uncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('Daftar isi arsip Office tidak valid.');
    }
    const flags = view.getUint16(offset + 8, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if ((flags & 1) || uncompressedSize === 0xffffffff) {
      throw new Error('Arsip Office terenkripsi atau memakai format ZIP64 yang tidak didukung.');
    }
    uncompressedBytes += uncompressedSize;
    if (uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error('Isi file Office terlalu besar untuk diproses dengan aman di browser.');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function parseXml(xml, description) {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error(`${description} tidak valid.`);
  return document;
}

function xmlTexts(element) {
  return [...element.getElementsByTagNameNS('*', 't')].map(node => node.textContent || '').join('');
}

function normalizedZipPath(path) {
  const segments = [];
  for (const segment of path.replace(/^\/+/, '').split('/')) {
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') segments.push(segment);
  }
  return segments.join('/');
}

function columnIndex(reference) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, index - 1);
}

function extractSpreadsheet(archive) {
  const decode = bytes => new TextDecoder().decode(bytes);
  const workbookXml = archive['xl/workbook.xml'];
  const relationshipsXml = archive['xl/_rels/workbook.xml.rels'];
  if (!workbookXml || !relationshipsXml) throw new Error('Struktur spreadsheet tidak lengkap.');

  const workbook = parseXml(decode(workbookXml), 'Daftar sheet');
  const relationships = parseXml(decode(relationshipsXml), 'Referensi sheet');
  const targets = new Map(
    [...relationships.getElementsByTagNameNS('*', 'Relationship')]
      .map(item => [item.getAttribute('Id'), item.getAttribute('Target')])
  );
  const sharedStrings = archive['xl/sharedStrings.xml']
    ? [...parseXml(decode(archive['xl/sharedStrings.xml']), 'Tabel teks')
      .getElementsByTagNameNS('*', 'si')].map(xmlTexts)
    : [];
  const output = [];

  for (const sheet of workbook.getElementsByTagNameNS('*', 'sheet')) {
    const name = sheet.getAttribute('name') || 'Sheet';
    const relationshipId = sheet.getAttributeNS(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'id'
    );
    const target = targets.get(relationshipId);
    if (!target) continue;
    const targetPath = normalizedZipPath(target.startsWith('/')
      ? target
      : target.startsWith('xl/') ? target : `xl/${target}`);
    const sheetBytes = archive[targetPath];
    if (!sheetBytes) continue;

    const sheetXml = parseXml(decode(sheetBytes), `Sheet ${name}`);
    output.push(`## ${name}`);
    for (const row of sheetXml.getElementsByTagNameNS('*', 'row')) {
      const cells = [...row.getElementsByTagNameNS('*', 'c')].filter(cell => cell.parentElement === row);
      const values = [];
      for (const cell of cells) {
        const index = columnIndex(cell.getAttribute('r') || '');
        const valueNode = cell.getElementsByTagNameNS('*', 'v')[0];
        const inlineText = cell.getElementsByTagNameNS('*', 'is')[0];
        const rawValue = valueNode?.textContent || (inlineText ? xmlTexts(inlineText) : '');
        const value = cell.getAttribute('t') === 's'
          ? sharedStrings[Number(rawValue)] || ''
          : rawValue;
        values[index] = value;
      }
      output.push(values.map(value => value || '').join('\t'));
      if (output.join('\n').length > MAX_EXTRACTED_TEXT) {
        throw new Error('Isi spreadsheet melewati batas teks yang dapat diproses.');
      }
    }
  }
  return output.join('\n').slice(0, MAX_EXTRACTED_TEXT);
}

function extractPresentation(archive) {
  const decode = bytes => new TextDecoder().decode(bytes);
  const slides = Object.keys(archive)
    .map(path => ({ path, match: path.match(/^ppt\/slides\/slide(\d+)\.xml$/) }))
    .filter(item => item.match)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
  if (!slides.length) throw new Error('Tidak ada slide yang dapat dibaca.');
  const output = [];
  for (const slide of slides.slice(0, 100)) {
    const document = parseXml(decode(archive[slide.path]), 'Slide');
    output.push(`## Slide ${slide.match[1]}`);
    output.push(...[...document.getElementsByTagNameNS('*', 'p')].map(xmlTexts).filter(Boolean));
    if (output.join('\n').length > MAX_EXTRACTED_TEXT) break;
  }
  return output.join('\n').slice(0, MAX_EXTRACTED_TEXT);
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error(`Gagal membaca ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function extractFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name}: ukuran file melebihi 10 MB.`);
  }
  const extension = extensionOf(file.name);
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) {
    if (file.type && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      throw new Error(`${file.name}: format gambar harus PNG, JPEG, atau WebP.`);
    }
    return { kind: 'image', dataUrl: await readAsDataUrl(file) };
  }

  if (extension === 'pdf') {
    const [pdfjsLib, workerAsset] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    ]);
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerAsset.default;
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      isEvalSupported: false
    }).promise;
    const pageCount = Math.min(pdf.numPages, 80);
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => 'str' in item ? item.str : '').filter(Boolean).join(' '));
      if (pages.join('\n').length > MAX_EXTRACTED_TEXT) break;
    }
    return {
      kind: 'text',
      text: pages.join('\n').slice(0, MAX_EXTRACTED_TEXT) +
        (pdf.numPages > pageCount ? '\n[Dokumen dipotong setelah 80 halaman.]' : '')
    };
  }

  if (['docx', 'xlsx', 'pptx'].includes(extension)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    validateZipArchive(bytes);
    if (extension === 'docx') {
      const { default: mammoth } = await import('mammoth/mammoth.browser');
      const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer });
      return { kind: 'text', text: result.value.slice(0, MAX_EXTRACTED_TEXT) };
    }
    const { unzipSync } = await import('fflate');
    const archive = unzipSync(bytes);
    return {
      kind: 'text',
      text: extension === 'xlsx' ? extractSpreadsheet(archive) : extractPresentation(archive)
    };
  }

  const textExtensions = /^(txt|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|log|html?|css|js|mjs|cjs|ts|jsx|tsx|vue|svelte|py|ipynb|java|kt|kts|cs|c|h|hpp|cpp|go|rs|rb|php|swift|sh|bash|ps1|sql|tf|properties|gradle|r|lua|pl|dockerfile|env)$/;
  const textMimeTypes = new Set([
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-yaml',
    'application/sql'
  ]);
  if (textExtensions.test(extension) || file.type.startsWith('text/') || textMimeTypes.has(file.type)) {
    const text = await file.text();
    if (text.length > MAX_EXTRACTED_TEXT) throw new Error(`${file.name}: teks melebihi batas 100.000 karakter.`);
    return { kind: 'text', text };
  }
  throw new Error(`${file.name}: format file tidak didukung.`);
}

async function createUserContent(text, files) {
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  let totalImageBytes = 0;
  let totalText = text.length;
  for (const file of files) {
    const extracted = await extractFile(file);
    if (extracted.kind === 'image') {
      totalImageBytes += file.size;
      if (totalImageBytes > MAX_TOTAL_IMAGES_BYTES) {
        throw new Error('Total ukuran gambar dalam satu pesan maksimal 5 MB.');
      }
      parts.push({ type: 'text', text: `[Gambar terlampir: ${file.name}]` });
      parts.push({ type: 'image_url', image_url: { url: extracted.dataUrl } });
    } else {
      totalText += extracted.text.length;
      if (totalText > MAX_EXTRACTED_TEXT) throw new Error('Total teks pesan dan lampiran maksimal 100.000 karakter.');
      parts.push({ type: 'text', text: `[File: ${file.name}]\n${extracted.text}` });
    }
  }
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

async function readJsonResponse(response) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    if (response.ok) throw new Error('Relay mengembalikan respons yang bukan JSON.');
  }

  if (!response.ok) {
    const error = payload?.error;
    const detail = typeof error === 'string' ? error : error?.message;
    throw new Error(detail
      ? `HTTP ${response.status}: ${detail}`
      : `HTTP ${response.status}. Periksa Worker, Base URL, API key, model, dan kuota.`);
  }
  return payload;
}

function validateProxyUrl(value) {
  const proxyUrl = value.trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(proxyUrl);
  } catch {
    throw new Error('URL Cloudflare Worker tidak valid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('URL Worker harus berupa alamat HTTPS utama, tanpa path, query, atau kredensial.');
  }
  return proxyUrl;
}

function parseModels(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Tambahkan setidaknya satu model atau muat daftar model dari API.');
  if (lines.length > MAX_MODELS_PER_PROVIDER) {
    throw new Error(`Maksimal ${MAX_MODELS_PER_PROVIDER} model per provider.`);
  }
  const seen = new Set();
  return lines.map((line, index) => {
    const [rawId, rawTiers = 'balanced'] = line.split('|');
    const id = rawId.trim();
    const tiers = rawTiers.split(',').map(tier => tier.trim().toLowerCase()).filter(Boolean);
    if (!id || id.length > 200) throw new Error(`ID model pada baris ${index + 1} tidak valid.`);
    if (seen.has(id)) throw new Error(`Model "${id}" tercantum lebih dari sekali.`);
    seen.add(id);
    const invalidTier = tiers.find(tier => !MODEL_TIERS.has(tier));
    if (invalidTier) throw new Error(`Level "${invalidTier}" tidak dikenal. Gunakan fast, balanced, deep, atau default.`);
    return { id, tiers: tiers.length ? [...new Set(tiers)] : ['balanced'] };
  });
}

function providerFromCard(card) {
  const name = card.querySelector('[data-field="name"]').value.trim();
  const apiBase = card.querySelector('[data-field="apiBase"]').value.trim().replace(/\/+$/, '');
  const apiKey = card.querySelector('[data-field="apiKey"]').value.trim();
  const models = parseModels(card.querySelector('[data-field="models"]').value);
  if (!name || !apiBase || !apiKey) throw new Error('Isi nama provider, Base URL, dan API key.');

  let url;
  try {
    url = new URL(apiBase);
  } catch {
    throw new Error('Base URL provider tidak valid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL provider harus HTTPS dan tidak boleh berisi kredensial, query, atau fragment.');
  }
  return { id: card.dataset.providerId, name, apiBase, apiKey, models };
}

function providerFingerprint(provider, proxyUrl = elements.proxyUrl.value.trim().replace(/\/+$/, '')) {
  return JSON.stringify([
    proxyUrl,
    provider.apiBase,
    provider.apiKey,
    provider.models
  ]);
}

function createField(labelText, input) {
  const label = document.createElement('label');
  label.textContent = labelText;
  label.append(input);
  return label;
}

function makeInput(field, type, placeholder, value = '') {
  const input = document.createElement('input');
  input.dataset.field = field;
  input.type = type;
  input.placeholder = placeholder;
  input.value = value;
  input.autocomplete = type === 'password' ? 'off' : 'off';
  return input;
}

function makeProviderCard(provider = {}) {
  const id = provider.id || crypto.randomUUID();
  const card = document.createElement('section');
  card.className = 'provider-card';
  card.dataset.providerId = id;

  const header = document.createElement('div');
  header.className = 'provider-card-header';
  const title = document.createElement('h3');
  title.textContent = provider.name || 'Koneksi provider';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-provider';
  remove.textContent = 'Hapus';
  remove.setAttribute('aria-label', `Hapus koneksi ${provider.name || 'provider'}`);
  remove.addEventListener('click', () => {
    providerTestFingerprints.delete(id);
    card.remove();
    updateProviderSaveState();
  });
  header.append(title, remove);

  const nameInput = makeInput('name', 'text', 'Contoh: Kunciai', provider.name || '');
  const baseInput = makeInput('apiBase', 'url', 'https://provider.example/v1', provider.apiBase || '');
  const keyInput = makeInput('apiKey', 'password', 'API key provider', provider.apiKey || '');
  const modelInput = document.createElement('textarea');
  modelInput.dataset.field = 'models';
  modelInput.rows = 3;
  modelInput.placeholder = 'model-id | balanced,deep';
  modelInput.value = (provider.models || [])
    .map(model => `${model.id} | ${(model.tiers || ['balanced']).join(',')}`)
    .join('\n');

  const actions = document.createElement('div');
  actions.className = 'provider-actions';
  const loadModels = document.createElement('button');
  loadModels.type = 'button';
  loadModels.className = 'text-button';
  loadModels.textContent = 'Muat model';
  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'text-button';
  test.textContent = 'Test koneksi';
  const status = document.createElement('span');
  status.className = 'provider-status';
  status.dataset.field = 'status';
  status.textContent = provider.tested ? 'Tersimpan' : 'Belum diuji';

  loadModels.addEventListener('click', () => loadProviderModels(card, loadModels));
  test.addEventListener('click', () => testProvider(card, test));
  actions.append(loadModels, test, status);
  card.append(
    header,
    createField('Nama provider', nameInput),
    createField('Base URL', baseInput),
    createField('API key', keyInput),
    createField('Model dan level', modelInput),
    actions
  );

  card.querySelectorAll('input, textarea').forEach(input => {
    input.addEventListener('input', () => {
      if (input.dataset.field === 'name') {
        title.textContent = input.value.trim() || 'Koneksi provider';
      } else {
        status.textContent = 'Perubahan perlu diuji ulang';
      }
      updateProviderSaveState();
    });
  });
  return card;
}

function renderProviderCards(providers) {
  elements.providerList.replaceChildren();
  const initialProviders = providers.length ? providers : [{}];
  for (const provider of initialProviders) elements.providerList.append(makeProviderCard(provider));
  updateProviderSaveState();
}

function updateProviderSaveState() {
  const cards = [...elements.providerList.querySelectorAll('.provider-card')];
  const readyCount = cards.filter(card => {
    try {
      const provider = providerFromCard(card);
      return providerTestFingerprints.get(provider.id) === providerFingerprint(provider);
    } catch {
      return false;
    }
  }).length;
  elements.addProvider.disabled = cards.length >= MAX_PROVIDERS;
  elements.saveSettings.disabled = cards.length === 0 || readyCount !== cards.length;
  elements.connectionStatus.textContent = cards.length
    ? `${readyCount} dari ${cards.length} koneksi sudah diuji.`
    : 'Tambahkan minimal satu koneksi provider.';
}

async function loadProviderModels(card, button) {
  const status = card.querySelector('[data-field="status"]');
  let proxyUrl;
  let apiBase;
  let apiKey;
  try {
    proxyUrl = validateProxyUrl(elements.proxyUrl.value);
    apiBase = card.querySelector('[data-field="apiBase"]').value.trim().replace(/\/+$/, '');
    apiKey = card.querySelector('[data-field="apiKey"]').value.trim();
    if (!apiBase || !apiKey) throw new Error('Isi Base URL dan API key sebelum memuat model.');
  } catch (error) {
    status.textContent = error.message;
    return;
  }

  button.disabled = true;
  status.textContent = 'Memuat daftar model...';
  try {
    const response = await fetch(`${proxyUrl}/api/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ baseUrl: apiBase })
    });
    const payload = await readJsonResponse(response);
    const ids = [...new Set((Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [])
      .map(model => typeof model === 'string' ? model : model?.id)
      .filter(id =>
        typeof id === 'string' &&
        id.trim() &&
        id.length <= 200 &&
        !/[\r\n|]/.test(id)
      ))]
      .slice(0, MAX_MODELS_PER_PROVIDER);
    if (!ids.length) throw new Error('API tidak mengembalikan daftar model. Tambahkan ID model secara manual.');

    const input = card.querySelector('[data-field="models"]');
    const currentIds = new Set(input.value.split(/\r?\n/).map(line => line.split('|')[0].trim()).filter(Boolean));
    const newLines = ids.filter(id => !currentIds.has(id)).map(id => `${id} | balanced`);
    input.value = [input.value.trim(), ...newLines].filter(Boolean).join('\n');
    input.dispatchEvent(new Event('input'));
    status.textContent = `${ids.length} model ditemukan. Pilih level untuk tiap model.`;
  } catch (error) {
    status.textContent = error instanceof TypeError
      ? 'Worker tidak dapat dijangkau; periksa URL Worker.'
      : `Gagal memuat model: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function testProvider(card, button) {
  const status = card.querySelector('[data-field="status"]');
  let proxyUrl;
  let provider;
  try {
    proxyUrl = validateProxyUrl(elements.proxyUrl.value);
    provider = providerFromCard(card);
  } catch (error) {
    status.textContent = error.message;
    updateProviderSaveState();
    return;
  }

  const model = provider.models[0];
  button.disabled = true;
  status.textContent = `Menguji ${model.id}...`;
  try {
    const response = await fetch(`${proxyUrl}/api/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ baseUrl: provider.apiBase, model: model.id })
    });
    const payload = await readJsonResponse(response);
    if (payload?.success !== true) throw new Error('Provider tidak mengonfirmasi koneksi.');
    const currentProvider = providerFromCard(card);
    if (providerFingerprint(currentProvider) !== providerFingerprint(provider)) {
      status.textContent = 'Pengaturan berubah saat diuji. Test lagi.';
      return;
    }
    providerTestFingerprints.set(provider.id, providerFingerprint(provider));
    status.textContent = `Terhubung: ${payload.model || model.id}`;
  } catch (error) {
    providerTestFingerprints.delete(provider.id);
    status.textContent = error instanceof TypeError
      ? 'Worker tidak dapat dijangkau atau origin tidak diizinkan.'
      : `Tes gagal: ${error.message}`;
  } finally {
    button.disabled = false;
    updateProviderSaveState();
  }
}

function updateSettingsForm() {
  elements.proxyUrl.value = settings.proxyUrl;
  renderProviderCards(settings.providers);
  elements.routeLabel.textContent = settings.providers[0]?.models?.[0]?.id
    ? `Model · ${settings.providers[0].models[0].id}`
    : 'Pilih tingkat AI';
  elements.aiLevel.value = localStorage.getItem('orbit.aiLevel.v1') || 'auto';
}

function openSettings() {
  updateSettingsForm();
  elements.settingsError.textContent = '';
  elements.settingsDialog.showModal();
}

function closeSidebar() {
  elements.sidebar.classList.remove('open');
  elements.sidebarBackdrop.classList.remove('visible');
}

function getSettingsFromForm() {
  const proxyUrl = validateProxyUrl(elements.proxyUrl.value);
  const cards = [...elements.providerList.querySelectorAll('.provider-card')];
  if (!cards.length || cards.length > MAX_PROVIDERS) {
    throw new Error(`Tambahkan 1 sampai ${MAX_PROVIDERS} koneksi provider.`);
  }
  const providers = cards.map(card => {
    const provider = providerFromCard(card);
    if (providerTestFingerprints.get(provider.id) !== providerFingerprint(provider, proxyUrl)) {
      throw new Error(`Test koneksi "${provider.name}" dengan pengaturan terbaru sebelum menyimpan.`);
    }
    return { ...provider, tested: true };
  });
  return { proxyUrl, providers, responseStyle: 'direct' };
}

function renderSelectedFiles() {
  elements.attachmentList.replaceChildren();
  elements.attachmentList.hidden = selectedFiles.length === 0;
  selectedFiles.forEach((file, index) => {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    const name = document.createElement('span');
    name.textContent = file.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Hapus lampiran ${file.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      selectedFiles.splice(index, 1);
      renderSelectedFiles();
    });
    chip.append(name, remove);
    elements.attachmentList.append(chip);
  });
}

function apiMessages(conversation) {
  const history = conversation.messages
    .filter(message => !message.error)
    .slice(-MAX_CONTEXT_MESSAGES);
  let lastUserIndex = -1;
  history.forEach((message, index) => {
    if (message.role === 'user') lastUserIndex = index;
  });
  const messages = history.map((message, index) => {
    let content = message.content;
    if (Array.isArray(content) && index !== lastUserIndex) {
      content = content.filter(part => part.type === 'text');
    }
    return { role: message.role, content };
  });
  const systemMessage = { role: 'system', content: SYSTEM_PROMPT };
  const encoder = new TextEncoder();
  let usedBytes = encoder.encode(JSON.stringify(systemMessage)).byteLength;
  const recentMessages = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const messageBytes = encoder.encode(JSON.stringify(messages[index])).byteLength + 1;
    if (usedBytes + messageBytes > MAX_API_CONTEXT_BYTES) break;
    usedBytes += messageBytes;
    recentMessages.push(messages[index]);
  }
  return [systemMessage, ...recentMessages.reverse()];
}

async function sendMessage(text) {
  if (!settings.proxyUrl || !settings.providers.length) {
    openSettings();
    showToast('Tambahkan provider, test koneksi, lalu simpan sebelum mengirim chat.');
    return;
  }
  if (sending) return;
  const files = [...selectedFiles];
  if (!text && !files.length) return;

  let route;
  try {
    route = chooseModel(
      settings.providers.filter(provider => provider.tested),
      text || 'Analisis lampiran',
      elements.aiLevel.value
    );
  } catch (error) {
    showToast(error.message);
    openSettings();
    return;
  }
  sending = true;
  elements.sendButton.disabled = true;
  elements.attachButton.disabled = true;
  elements.fileInput.disabled = true;

  const now = Date.now();
  let conversation;
  try {
    if (files.length > MAX_FILES) throw new Error(`Maksimal ${MAX_FILES} file per pesan.`);
    const content = await createUserContent(text, files);
    selectedFiles = [];
    renderSelectedFiles();
    conversation = activeConversation() || {
      id: crypto.randomUUID(),
      title: (text || files[0]?.name || 'Percakapan baru').trim().replace(/\s+/g, ' ').slice(0, 42),
      messages: [],
      createdAt: now,
      updatedAt: now
    };
    currentConversationId = conversation.id;
    conversation.messages.push({ role: 'user', content, createdAt: now });
    conversation.updatedAt = now;
    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto';
    await saveConversation(conversation);
    renderMessages();
    showTyping();

    const response = await fetch(`${settings.proxyUrl}/api/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${route.provider.apiKey}`
      },
      body: JSON.stringify({
        baseUrl: route.provider.apiBase,
        model: route.model.id,
        messages: apiMessages(conversation),
        temperature: 0.7,
        max_tokens: 1_000
      })
    });
    const payload = await readJsonResponse(response);
    const responseContent = payload?.choices?.[0]?.message?.content;
    const reply = typeof responseContent === 'string'
      ? responseContent
      : Array.isArray(responseContent)
        ? responseContent.filter(part => part?.type === 'text').map(part => part.text).join('\n')
        : '';
    if (!reply.trim()) {
      throw new Error('API tidak mengembalikan teks jawaban yang valid.');
    }

    conversation.messages.push({
      role: 'assistant',
      content: reply.trim(),
      model: typeof payload.model === 'string' ? payload.model : route.model.id,
      createdAt: Date.now()
    });
    conversation.updatedAt = Date.now();
    await saveConversation(conversation);
    elements.routeLabel.textContent =
      `${route.provider.name} · ${typeof payload.model === 'string' ? payload.model : route.model.id} · ${route.tier}`;
  } catch (error) {
    if (!conversation) {
      showToast(`Lampiran tidak dapat diproses: ${error.message}`);
    } else {
      conversation.messages.push({
        role: 'assistant',
        content: error instanceof TypeError
          ? 'Browser gagal menjangkau Cloudflare Worker. Pastikan Worker aktif, URL benar, dan origin GitHub Pages diizinkan oleh Worker.'
          : `Gagal menghubungi API: ${error.message}`,
        error: true,
        createdAt: Date.now()
      });
      conversation.updatedAt = Date.now();
      try {
        await saveConversation(conversation);
      } catch (saveError) {
        showToast(`Jawaban gagal dan riwayat tidak dapat disimpan: ${saveError.message}`);
      }
    }
  } finally {
    document.querySelector('#typingIndicator')?.remove();
    sending = false;
    elements.sendButton.disabled = false;
    elements.attachButton.disabled = false;
    elements.fileInput.disabled = false;
    renderMessages();
    elements.messageInput.focus();
  }
}

elements.chatForm.addEventListener('submit', event => {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  if (text || selectedFiles.length) sendMessage(text);
});

elements.attachButton.addEventListener('click', () => elements.fileInput.click());
elements.fileInput.addEventListener('change', () => {
  const availableSlots = MAX_FILES - selectedFiles.length;
  const additions = [...elements.fileInput.files].slice(0, Math.max(0, availableSlots));
  if (elements.fileInput.files.length > availableSlots) {
    showToast(`Maksimal ${MAX_FILES} file per pesan.`);
  }
  selectedFiles.push(...additions);
  elements.fileInput.value = '';
  renderSelectedFiles();
});

elements.messageInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    elements.chatForm.requestSubmit();
  }
});

elements.messageInput.addEventListener('input', () => {
  elements.messageInput.style.height = 'auto';
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 180)}px`;
});

document.querySelector('#newChat').addEventListener('click', createConversation);
document.querySelector('#openSettings').addEventListener('click', openSettings);
document.querySelector('#openSettingsTop').addEventListener('click', openSettings);
elements.addProvider.addEventListener('click', () => {
  const cards = elements.providerList.querySelectorAll('.provider-card');
  if (cards.length >= MAX_PROVIDERS) return;
  elements.providerList.append(makeProviderCard());
  updateProviderSaveState();
});
elements.proxyUrl.addEventListener('input', updateProviderSaveState);
elements.aiLevel.addEventListener('change', () => {
  localStorage.setItem('orbit.aiLevel.v1', elements.aiLevel.value);
});
document.querySelector('#closeSettings').addEventListener('click', () => elements.settingsDialog.close());
document.querySelector('#cancelSettings').addEventListener('click', () => elements.settingsDialog.close());
document.querySelector('#openSidebar').addEventListener('click', () => {
  elements.sidebar.classList.add('open');
  elements.sidebarBackdrop.classList.add('visible');
});
document.querySelector('#closeSidebar').addEventListener('click', closeSidebar);
elements.sidebarBackdrop.addEventListener('click', closeSidebar);

document.querySelectorAll('.suggestion').forEach(button => {
  button.addEventListener('click', () => {
    elements.messageInput.value = button.dataset.prompt || '';
    elements.messageInput.dispatchEvent(new Event('input'));
    elements.messageInput.focus();
  });
});

elements.settingsForm.addEventListener('submit', event => {
  event.preventDefault();
  elements.settingsError.textContent = '';
  try {
    const updatedSettings = getSettingsFromForm();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updatedSettings));
    settings = updatedSettings;
    providerTestFingerprints = new Map(
      updatedSettings.providers.map(provider => [provider.id, providerFingerprint(provider, updatedSettings.proxyUrl)])
    );
    updateSettingsForm();
    elements.settingsDialog.close();
    showToast('Pengaturan disimpan lokal di browser ini.');
  } catch (error) {
    elements.settingsError.textContent = error.message;
  }
});

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    createConversation();
  }
  if (event.key === 'Escape') closeSidebar();
});

async function initialize() {
  updateSettingsForm();
  try {
    db = await openDatabase();
    await loadConversations();
  } catch (error) {
    showToast(`Riwayat lokal tidak tersedia: ${error.message}`);
  }
  if (!settings.proxyUrl || !settings.providers.some(provider => provider.tested)) {
    openSettings();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(error => {
      showToast(`Mode offline tidak aktif: ${error.message}`);
    });
  }
}

initialize();
