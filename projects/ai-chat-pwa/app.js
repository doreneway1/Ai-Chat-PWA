const SETTINGS_KEY = 'orbit.settings.v1';
const DB_NAME = 'orbit-local-chat';
const DB_VERSION = 1;
const MAX_CONTEXT_MESSAGES = 40;

const elements = {
  conversationList: document.querySelector('#conversationList'),
  welcome: document.querySelector('#welcome'),
  messages: document.querySelector('#messages'),
  chatForm: document.querySelector('#chatForm'),
  messageInput: document.querySelector('#messageInput'),
  sendButton: document.querySelector('#sendButton'),
  settingsDialog: document.querySelector('#settingsDialog'),
  settingsForm: document.querySelector('#settingsForm'),
  settingsError: document.querySelector('#settingsError'),
  proxyUrl: document.querySelector('#proxyUrl'),
  apiBase: document.querySelector('#apiBase'),
  modelAlias: document.querySelector('#modelAlias'),
  apiKey: document.querySelector('#apiKey'),
  testConnection: document.querySelector('#testConnection'),
  connectionStatus: document.querySelector('#connectionStatus'),
  saveSettings: document.querySelector('#saveSettings'),
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
let settings = readSettings();
let testedSettingsFingerprint = settings.tested ? fingerprint(settings) : '';

function readSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      proxyUrl: saved.proxyUrl || '',
      apiBase: saved.apiBase || 'https://ai.ipeenk.com/v1',
      modelAlias: saved.modelAlias || saved.autoModel || 'deepseek-v4-pro',
      apiKey: saved.apiKey || '',
      tested: saved.tested === true
    };
  } catch (error) {
    showToast(`Pengaturan lokal tidak dapat dibaca: ${error.message}`);
    return {
      proxyUrl: '',
      apiBase: 'https://ai.ipeenk.com/v1',
      modelAlias: 'deepseek-v4-pro',
      apiKey: '',
      tested: false
    };
  }
}

function fingerprint(config) {
  return JSON.stringify([config.proxyUrl, config.apiBase, config.modelAlias, config.apiKey]);
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
  elements.messages.scrollTop = elements.messages.scrollHeight;
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
  content.textContent = message.content;
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
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function getSettingsFromForm() {
  const proxyUrl = elements.proxyUrl.value.trim().replace(/\/+$/, '');
  const apiBase = elements.apiBase.value.trim().replace(/\/+$/, '');
  const modelAlias = elements.modelAlias.value.trim();
  const apiKey = elements.apiKey.value.trim();
  if (!proxyUrl || !apiBase || !modelAlias || !apiKey) {
    throw new Error('URL Worker, Base URL API, model ID/alias, dan API key harus diisi.');
  }

  let worker;
  try {
    worker = new URL(proxyUrl);
  } catch {
    throw new Error('URL Cloudflare Worker tidak valid.');
  }
  if (worker.protocol !== 'https:' || worker.username || worker.password || worker.search || worker.hash || worker.pathname !== '/') {
    throw new Error('URL Worker harus berupa alamat HTTPS utama, tanpa path, query, atau kredensial.');
  }

  let api;
  try {
    api = new URL(apiBase);
  } catch {
    throw new Error('Base URL API tidak valid.');
  }
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) {
    throw new Error('Base URL API harus HTTPS dan tidak boleh berisi kredensial, query, atau fragment.');
  }
  return { proxyUrl, apiBase, modelAlias, apiKey };
}

function updateSettingsForm() {
  elements.proxyUrl.value = settings.proxyUrl;
  elements.apiBase.value = settings.apiBase;
  elements.modelAlias.value = settings.modelAlias;
  elements.apiKey.value = settings.apiKey;
  elements.routeLabel.textContent = settings.modelAlias ? `Model · ${settings.modelAlias}` : 'Model belum diatur';
  updateConnectionStatus();
}

function updateConnectionStatus(message) {
  if (message) {
    elements.connectionStatus.textContent = message;
    return;
  }

  let matchesLastTest = false;
  try {
    matchesLastTest = Boolean(
      testedSettingsFingerprint &&
      fingerprint(getSettingsFromForm()) === testedSettingsFingerprint
    );
  } catch {
    matchesLastTest = false;
  }
  elements.saveSettings.disabled = !matchesLastTest;
  elements.connectionStatus.textContent = matchesLastTest
    ? 'Koneksi sudah diuji. Pengaturan siap disimpan.'
    : 'Tes koneksi sebelum menyimpan.';
}

function openSettings() {
  updateSettingsForm();
  elements.settingsError.textContent = '';
  elements.settingsDialog.showModal();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 4000);
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

async function testConnection() {
  elements.settingsError.textContent = '';
  let config;
  try {
    config = getSettingsFromForm();
  } catch (error) {
    elements.settingsError.textContent = error.message;
    return;
  }

  elements.testConnection.disabled = true;
  elements.saveSettings.disabled = true;
  updateConnectionStatus('Menguji Worker, API key, dan model...');
  try {
    const response = await fetch(`${config.proxyUrl}/api/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({ baseUrl: config.apiBase, model: config.modelAlias })
    });
    const payload = await readJsonResponse(response);
    if (payload?.success !== true) throw new Error('Relay tidak mengonfirmasi koneksi berhasil.');

    let currentFingerprint = '';
    try {
      currentFingerprint = fingerprint(getSettingsFromForm());
    } catch {
      currentFingerprint = '';
    }
    if (currentFingerprint !== fingerprint(config)) {
      testedSettingsFingerprint = '';
      updateConnectionStatus('Pengaturan berubah saat pengujian. Jalankan test lagi.');
      return;
    }

    testedSettingsFingerprint = fingerprint(config);
    elements.saveSettings.disabled = false;
    updateConnectionStatus(`Berhasil terhubung${payload.model ? ` · ${payload.model}` : ''}. Kamu bisa menyimpan pengaturan.`);
  } catch (error) {
    testedSettingsFingerprint = '';
    elements.saveSettings.disabled = true;
    updateConnectionStatus(error instanceof TypeError
      ? 'Worker tidak dapat dijangkau atau origin belum diizinkan. Periksa URL dan konfigurasi Worker.'
      : `Tes gagal: ${error.message}`);
  } finally {
    elements.testConnection.disabled = false;
  }
}

function closeSidebar() {
  elements.sidebar.classList.remove('open');
  elements.sidebarBackdrop.classList.remove('visible');
}

async function sendMessage(text) {
  if (!settings.proxyUrl || !settings.apiBase || !settings.modelAlias || !settings.apiKey || !settings.tested) {
    openSettings();
    showToast('Lengkapi pengaturan, test koneksi, lalu simpan sebelum mengirim chat.');
    return;
  }
  if (sending) return;
  sending = true;
  elements.sendButton.disabled = true;

  const now = Date.now();
  const conversation = activeConversation() || {
    id: crypto.randomUUID(),
    title: text.trim().replace(/\s+/g, ' ').slice(0, 42) || 'Percakapan baru',
    messages: [],
    createdAt: now,
    updatedAt: now
  };
  currentConversationId = conversation.id;
  conversation.messages.push({ role: 'user', content: text, createdAt: now });
  conversation.updatedAt = now;
  elements.messageInput.value = '';
  elements.messageInput.style.height = 'auto';

  try {
    await saveConversation(conversation);
    renderMessages();
    showTyping();

    const response = await fetch(`${settings.proxyUrl}/api/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        baseUrl: settings.apiBase,
        model: settings.modelAlias,
        messages: conversation.messages
          .filter(message => !message.error)
          .slice(-MAX_CONTEXT_MESSAGES)
          .map(({ role, content }) => ({ role, content })),
          temperature: 0.7,
          max_tokens: 500
      })
    });
    const payload = await readJsonResponse(response);
    const reply = payload?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      throw new Error('API tidak mengembalikan teks jawaban yang valid.');
    }

    conversation.messages.push({
      role: 'assistant',
      content: reply.trim(),
      model: typeof payload.model === 'string' ? payload.model : settings.modelAlias,
      createdAt: Date.now()
    });
    conversation.updatedAt = Date.now();
    await saveConversation(conversation);
    elements.routeLabel.textContent = `Model · ${typeof payload.model === 'string' ? payload.model : settings.modelAlias}`;
  } catch (error) {
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
  } finally {
    document.querySelector('#typingIndicator')?.remove();
    sending = false;
    elements.sendButton.disabled = false;
    renderMessages();
    elements.messageInput.focus();
  }
}

elements.chatForm.addEventListener('submit', event => {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  if (text) sendMessage(text);
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
elements.testConnection.addEventListener('click', testConnection);
document.querySelector('#closeSettings').addEventListener('click', () => elements.settingsDialog.close());
document.querySelector('#cancelSettings').addEventListener('click', () => elements.settingsDialog.close());
[
  elements.proxyUrl,
  elements.apiBase,
  elements.modelAlias,
  elements.apiKey
].forEach(input => input.addEventListener('input', () => updateConnectionStatus()));
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
    if (fingerprint(updatedSettings) !== testedSettingsFingerprint) {
      throw new Error('Test koneksi dengan pengaturan terbaru sebelum menyimpan.');
    }
    updatedSettings.tested = true;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updatedSettings));
    settings = updatedSettings;
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
  if (!settings.proxyUrl || !settings.apiBase || !settings.apiKey || !settings.modelAlias || !settings.tested) {
    openSettings();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(error => {
      showToast(`Mode offline tidak aktif: ${error.message}`);
    });
  }
}

initialize();
