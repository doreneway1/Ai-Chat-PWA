// wa-bot-worker.mjs — Bot auto-reply WhatsApp (Cloud API) + AI + panel inbox
// sendiri, semua jalan di satu Cloudflare Worker.
//
// Cara kerja:
//   1. Meta mengirim pesan WA masuk ke webhook ini (POST /webhook).
//   2. Worker memverifikasi signature Meta, lalu membalas 200 secepatnya
//      (pekerjaan berat jalan di background lewat ctx.waitUntil supaya
//      Meta tidak menganggap webhook gagal dan mengirim ulang).
//   3. Pesan disimpan ke KV (kalau binding INBOX_KV dipasang) supaya bisa
//      dilihat di panel.
//   4. Kalau bot tidak dijeda untuk nomor itu, Worker memanggil AI (API
//      yang kompatibel OpenAI, sama seperti yang dipakai Orbit Chat) dan
//      mengirim jawabannya lewat Cloud API.
//
// Panel inbox (jalur API-only, tanpa aplikasi WhatsApp Business):
//   Buka https://<worker-kamu>.workers.dev/panel, login dengan username
//   "admin" dan password PANEL_PASSWORD. Di panel kamu bisa melihat semua
//   percakapan, membalas manual, dan menjeda bot untuk satu nomor supaya
//   kamu yang pegang percakapannya.
//
// Yang perlu diisi sebagai Secrets / Variables di dashboard Cloudflare
// (Workers → worker ini → Settings → Variables):
//   WAJIB (bot):
//     VERIFY_TOKEN     Token verifikasi webhook, bebas kamu tentukan sendiri
//                      (misal: string acak). Harus sama dengan yang diisi
//                      di dashboard Meta.
//     WHATSAPP_TOKEN   Token permanen (System User) dari Meta for Developers.
//     PHONE_NUMBER_ID  Phone Number ID dari Meta (bukan nomor teleponnya).
//     AI_API_KEY       API key provider AI (sama seperti di Orbit Chat).
//     AI_BASE_URL      Base URL provider AI, HTTPS dan berakhiran /v1.
//                      Contoh: https://ai.ipeenk.com/v1
//     AI_MODEL         Model yang dipakai, misal: gpt-4o-mini
//   OPSIONAL:
//     APP_SECRET       App Secret dari Meta. Kalau diisi, setiap webhook
//                      diverifikasi signature-nya (disarankan).
//     SYSTEM_PROMPT    Kepribadian bot. Kalau kosong, pakai default di bawah.
//     BOT_NAME         Nama bot yang dipakai di system prompt default.
//     PANEL_PASSWORD   Password login panel (username: admin). Kalau tidak
//                      diisi, panel nonaktif (semua route /panel 401).
//
// Binding KV (untuk panel):
//   Buat namespace KV di dashboard Cloudflare (Workers & Pages → KV),
//   lalu di Worker ini tambahkan binding (Settings → Bindings → Add
//   binding → KV Namespace) dengan nama variabel INBOX_KV. Tanpa binding
//   ini bot tetap jalan dan membalas, tapi pesan tidak disimpan dan
//   panel kosong.
//
// Catatan biaya: balasan untuk orang yang chat duluan adalah "service
// message". 1.000 service message pertama per nomor per bulan gratis,
// selebihnya $0,025 per balasan ke nomor Indonesia (tarif Okt 2026).

const GRAPH_VERSION = 'v26.0';
const MAX_REPLY_CHARS = 4000; // Batas teks WhatsApp: 4096 karakter.
const AI_TIMEOUT_MS = 25_000;
const AI_MAX_TOKENS = 800;
const MAX_USER_MESSAGE_CHARS = 4000;
const MAX_DEDUP_IDS = 500;
const MAX_STORED_PER_CONV = 200;

const DEFAULT_SYSTEM_PROMPT =
  'Kamu adalah asisten WhatsApp yang ramah dan membantu. ' +
  'Jawab dalam Bahasa Indonesia yang santai dan singkat, ' +
  'langsung ke intinya, tanpa basa-basi berlebihan. ' +
  'Kalau tidak tahu jawabannya, katakan dengan jujur.';

// Dedup best-effort dalam satu isolate Worker: Meta bisa mengirim ulang
// event yang sama kalau tidak menerima 200 (retry sampai 7 hari).
// Untuk dedup yang dijamin, simpan message ID di KV atau Durable Object.
const seenMessageIds = new Set();

function graphUrl(env, path) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Verifikasi X-Hub-Signature-256: HMAC-SHA256 dari raw body dengan App Secret.
// Memakai crypto.subtle.verify supaya perbandingannya timing-safe.
async function verifySignature(appSecret, rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const signatureBytes = hexToBytes(signatureHeader.slice('sha256='.length));
  if (!signatureBytes) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(appSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    return await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      new TextEncoder().encode(rawBody)
    );
  } catch {
    return false;
  }
}

function validateAiBaseUrl(value) {
  if (typeof value !== 'string' || !value) {
    throw new Error('AI_BASE_URL belum diisi.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('AI_BASE_URL tidak valid.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'https:' || !/(^|\/)v1$/.test(path)) {
    throw new Error('AI_BASE_URL harus HTTPS dan berakhiran /v1.');
  }
  return `${url.origin}${path}`;
}

async function callAi(env, userText) {
  const baseUrl = validateAiBaseUrl(env.AI_BASE_URL);
  const systemPrompt = (env.SYSTEM_PROMPT || '').trim() ||
    (env.BOT_NAME
      ? DEFAULT_SYSTEM_PROMPT.replace('asisten WhatsApp', `asisten WhatsApp bernama ${env.BOT_NAME}`)
      : DEFAULT_SYSTEM_PROMPT);

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.AI_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      model: env.AI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ],
      temperature: 0.7,
      max_tokens: AI_MAX_TOKENS
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS)
  });

  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const detail = payload?.error?.message || payload?.error || `HTTP ${upstream.status}`;
    throw new Error(`AI membalas error: ${detail}`);
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('AI tidak mengembalikan jawaban teks.');
  }
  return content.trim().slice(0, MAX_REPLY_CHARS);
}

async function sendWhatsAppText(env, to, body) {
  const response = await fetch(
    graphUrl(env, `${env.PHONE_NUMBER_ID}/messages`),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body }
      })
    }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Gagal mengirim balasan WA: ${detail}`);
  }
  return payload?.messages?.[0]?.id || '';
}

// Tandai pesan sebagai dibaca + tampilkan indikator "mengetik".
// Best-effort: gagal di sini tidak boleh menggagalkan balasan.
async function markAsRead(env, messageId) {
  try {
    await fetch(graphUrl(env, `${env.PHONE_NUMBER_ID}/messages`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' }
      })
    });
  } catch (error) {
    console.warn('markAsRead gagal:', error?.message || error);
  }
}

// ---------------------------------------------------------------------------
// Penyimpanan panel (KV). Semua fungsi di sini diam-diam tidak melakukan
// apa-apa kalau binding INBOX_KV tidak dipasang, supaya bot tetap jalan.
// ---------------------------------------------------------------------------

function kvStore(env) {
  return env.INBOX_KV || null;
}

async function kvGetJson(store, key) {
  if (!store) return null;
  try {
    const raw = await store.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function kvPutJson(store, key, value) {
  if (!store) return;
  try {
    await store.put(key, JSON.stringify(value));
  } catch (error) {
    console.warn('KV put gagal:', key, error?.message || error);
  }
}

// Simpan satu pesan ke riwayat percakapan nomor itu + perbarui indeks.
// direction: 'in' (dari pelanggan) atau 'out' (balasan bot/manual).
async function storeMessage(env, { id, phone, direction, text, timestamp }) {
  const store = kvStore(env);
  if (!store) return;
  const key = `conv:${phone}`;
  const list = (await kvGetJson(store, key)) || [];
  list.push({ id, phone, direction, text, timestamp });
  while (list.length > MAX_STORED_PER_CONV) list.shift();
  await kvPutJson(store, key, list);

  const convs = (await kvGetJson(store, 'convs')) || {};
  const prev = convs[phone] || { unread: 0 };
  convs[phone] = {
    phone,
    lastText: text,
    lastAt: timestamp,
    lastDirection: direction,
    unread: direction === 'in' ? (prev.unread || 0) + 1 : 0
  };
  await kvPutJson(store, 'convs', convs);
}

async function isBotPaused(env, phone) {
  const store = kvStore(env);
  if (!store) return false;
  const value = await kvGetJson(store, `pause:${phone}`);
  return value?.paused === true;
}

async function setBotPaused(env, phone, paused) {
  const store = kvStore(env);
  if (!store) return false;
  await kvPutJson(store, `pause:${phone}`, { paused });
  return true;
}

async function markConversationRead(env, phone) {
  const store = kvStore(env);
  if (!store) return;
  const convs = (await kvGetJson(store, 'convs')) || {};
  if (convs[phone] && convs[phone].unread) {
    convs[phone].unread = 0;
    await kvPutJson(store, 'convs', convs);
  }
}

// ---------------------------------------------------------------------------
// Alur pesan masuk (webhook)
// ---------------------------------------------------------------------------

async function handleIncomingMessage(env, message) {
  // Hanya pesan teks yang dibalas di v1. Gambar, suara, stiker, dan
  // tipe lain diabaikan supaya tidak menghabiskan jatah pesan.
  if (message?.type !== 'text') return;
  const userText = message.text?.body?.trim();
  if (!userText) return;

  const from = message.from; // Nomor pengirim, format internasional tanpa "+".
  const messageId = message.id;

  if (messageId) {
    if (seenMessageIds.has(messageId)) return; // Duplikat dari retry Meta.
    seenMessageIds.add(messageId);
    if (seenMessageIds.size > MAX_DEDUP_IDS) {
      seenMessageIds.delete(seenMessageIds.values().next().value);
    }
  }

  const now = Date.now();
  const cleanText = userText.slice(0, MAX_USER_MESSAGE_CHARS);
  // Simpan dulu supaya pesan tetap terlihat di panel walau bot dijeda
  // atau AI sedang error.
  await storeMessage(env, {
    id: messageId || `in-${now}`,
    phone: from,
    direction: 'in',
    text: cleanText,
    timestamp: now
  });

  // Dijeda dari panel: hanya disimpan, tidak dibalas bot.
  if (await isBotPaused(env, from)) return;

  await markAsRead(env, messageId);

  let reply;
  try {
    reply = await callAi(env, cleanText);
  } catch (error) {
    console.error('callAi gagal:', error?.message || error);
    reply = 'Maaf, saya sedang bermasalah sebentar. Coba kirim lagi beberapa saat ya.';
  }

  try {
    const sentId = await sendWhatsAppText(env, from, reply);
    await storeMessage(env, {
      id: sentId || `out-${Date.now()}`,
      phone: from,
      direction: 'out',
      text: reply,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('sendWhatsAppText gagal:', error?.message || error);
  }
}

function collectTextMessages(payload) {
  const messages = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};
      // value.statuses adalah laporan terkirim/dibaca, bukan pesan masuk.
      const incoming = Array.isArray(value.messages) ? value.messages : [];
      for (const message of incoming) {
        messages.push(message);
      }
    }
  }
  return messages;
}

function handleVerification(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token && env.VERIFY_TOKEN && token === env.VERIFY_TOKEN) {
    return new Response(challenge || '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

async function handleWebhookPost(request, env, ctx) {
  const rawBody = await request.text();

  // Kalau APP_SECRET diisi, tolak webhook yang signature-nya tidak cocok.
  if (env.APP_SECRET) {
    const ok = await verifySignature(
      env.APP_SECRET,
      rawBody,
      request.headers.get('X-Hub-Signature-256')
    );
    if (!ok) {
      console.warn('Webhook ditolak: signature tidak valid.');
      return new Response('Forbidden', { status: 403 });
    }
  }

  let payload = null;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const messages = collectTextMessages(payload);
  if (messages.length > 0) {
    // Kerja berat di background; respons 200 langsung supaya Meta tidak retry.
    ctx.waitUntil(
      (async () => {
        for (const message of messages) {
          await handleIncomingMessage(env, message);
        }
      })()
    );
  }
  return new Response('EVENT_RECEIVED', { status: 200 });
}

// ---------------------------------------------------------------------------
// Panel inbox (/panel)
// ---------------------------------------------------------------------------

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Login panel: HTTP Basic Auth, username "admin", password PANEL_PASSWORD.
// Kalau PANEL_PASSWORD tidak diisi, panel nonaktif.
function checkPanelAuth(request, env) {
  const password = env.PANEL_PASSWORD;
  if (!password) return false;
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = atob(header.slice('Basic '.length));
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  return decoded.slice(0, sep) === 'admin' &&
    timingSafeEqual(decoded.slice(sep + 1), password);
}

function unauthorizedResponse() {
  return new Response('Login panel diperlukan.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Panel WhatsApp"' }
  });
}

function cleanPhone(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

async function handlePanelApi(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/panel/api/conversations' && request.method === 'GET') {
    const store = kvStore(env);
    const convs = (await kvGetJson(store, 'convs')) || {};
    const list = Object.values(convs).sort((a, b) => b.lastAt - a.lastAt);
    for (const conv of list) {
      conv.paused = await isBotPaused(env, conv.phone);
    }
    return jsonResponse(list);
  }

  if (url.pathname === '/panel/api/messages' && request.method === 'GET') {
    const phone = cleanPhone(url.searchParams.get('to'));
    if (!phone) return jsonResponse({ error: 'Parameter to wajib.' }, 400);
    const store = kvStore(env);
    const list = (await kvGetJson(store, `conv:${phone}`)) || [];
    await markConversationRead(env, phone);
    return jsonResponse(list);
  }

  if (url.pathname === '/panel/api/send' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Body harus JSON.' }, 400);
    }
    const to = cleanPhone(body?.to);
    const text = String(body?.body || '').trim();
    if (!to || !text) {
      return jsonResponse({ error: 'to dan body wajib diisi.' }, 400);
    }
    try {
      const sentId = await sendWhatsAppText(env, to, text.slice(0, MAX_REPLY_CHARS));
      await storeMessage(env, {
        id: sentId || `out-${Date.now()}`,
        phone: to,
        direction: 'out',
        text: text.slice(0, MAX_REPLY_CHARS),
        timestamp: Date.now()
      });
      return jsonResponse({ ok: true, id: sentId });
    } catch (error) {
      return jsonResponse({ error: error.message }, 502);
    }
  }

  if (url.pathname === '/panel/api/pause' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Body harus JSON.' }, 400);
    }
    const to = cleanPhone(body?.to);
    const paused = body?.paused === true;
    if (!to) return jsonResponse({ error: 'to wajib diisi.' }, 400);
    await setBotPaused(env, to, paused);
    return jsonResponse({ ok: true, paused });
  }

  return jsonResponse({ error: 'Route panel tidak ditemukan.' }, 404);
}

function panelHtml() {
  return '<!DOCTYPE html>\n' +
    '<html lang="id">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>Panel WhatsApp</title>\n' +
    '<style>\n' +
    '*{box-sizing:border-box} body{margin:0;font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:#efeae2;color:#111b21}\n' +
    'header{background:#075e54;color:#fff;padding:12px 16px;font-size:18px;font-weight:600}\n' +
    'header span{font-weight:400;font-size:13px;opacity:.85;margin-left:8px}\n' +
    '#app{display:flex;height:calc(100vh - 49px)}\n' +
    '#list{width:320px;min-width:260px;background:#fff;border-right:1px solid #d1d7db;overflow-y:auto}\n' +
    '.conv{padding:12px 14px;border-bottom:1px solid #f0f2f5;cursor:pointer}\n' +
    '.conv.active{background:#f0f2f5} .conv:hover{background:#f5f6f6}\n' +
    '.conv .top{display:flex;justify-content:space-between;gap:8px}\n' +
    '.conv .phone{font-weight:600;font-size:15px}\n' +
    '.conv .time{font-size:12px;color:#667781;white-space:nowrap}\n' +
    '.conv .last{font-size:13px;color:#667781;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}\n' +
    '.badge{display:inline-block;background:#25d366;color:#fff;font-size:11px;font-weight:700;border-radius:10px;padding:1px 7px;margin-left:6px}\n' +
    '.paused-tag{display:inline-block;background:#ffad33;color:#111;font-size:11px;font-weight:700;border-radius:10px;padding:1px 7px;margin-left:6px}\n' +
    '#chat{flex:1;display:flex;flex-direction:column;min-width:0}\n' +
    '#chathead{padding:10px 14px;background:#f0f2f5;border-bottom:1px solid #d1d7db;display:flex;justify-content:space-between;align-items:center;gap:8px}\n' +
    '#chathead .phone{font-weight:600}\n' +
    '#pauseBtn{border:1px solid #8696a0;background:#fff;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:13px}\n' +
    '#pauseBtn.on{background:#ffad33;border-color:#ffad33}\n' +
    '#msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}\n' +
    '.msg{max-width:75%;padding:8px 10px;border-radius:8px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word}\n' +
    '.msg.in{background:#fff;align-self:flex-start}\n' +
    '.msg.out{background:#d9fdd3;align-self:flex-end}\n' +
    '.msg .t{font-size:11px;color:#667781;text-align:right;margin-top:4px}\n' +
    '#composer{display:flex;gap:8px;padding:10px;background:#f0f2f5;border-top:1px solid #d1d7db}\n' +
    '#composer input{flex:1;border:none;border-radius:8px;padding:10px 12px;font-size:15px;outline:none}\n' +
    '#composer button{border:none;background:#00a884;color:#fff;border-radius:8px;padding:0 18px;font-size:15px;cursor:pointer}\n' +
    '#empty{flex:1;display:flex;align-items:center;justify-content:center;color:#667781;padding:24px;text-align:center}\n' +
    '@media (max-width:700px){ #app{flex-direction:column} #list{width:100%;min-width:0;max-height:38vh} }\n' +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<header>Panel WhatsApp <span>bot + balas manual</span></header>\n' +
    '<div id="app">\n' +
    '<div id="list"></div>\n' +
    '<div id="chat"><div id="empty">Pilih percakapan di sebelah kiri.<br>Pesan baru masuk otomatis, panel me-refresh tiap 5 detik.</div></div>\n' +
    '</div>\n' +
    '<script>\n' +
    'var active=null, paused=false;\n' +
    'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}\n' +
    'function fmt(ts){try{return new Date(ts).toLocaleString("id-ID",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});}catch(e){return "";}}\n' +
    'async function api(path,opts){var r=await fetch(path,opts); if(!r.ok){throw new Error("HTTP "+r.status);} return r.json();}\n' +
    'async function loadConvs(){\n' +
    '  var list=await api("/panel/api/conversations");\n' +
    '  var el=document.getElementById("list");\n' +
    '  if(!list.length){el.innerHTML="<div style=\\"padding:16px;color:#667781\\">Belum ada percakapan. Pesan masuk akan muncul di sini.</div>";return;}\n' +
    '  el.innerHTML=list.map(function(c){\n' +
    '    var b=(c.unread? "<span class=\\"badge\\">"+c.unread+"</span>":"")+(c.paused? "<span class=\\"paused-tag\\">JEDA</span>":"");\n' +
    '    return "<div class=\\"conv"+(active===c.phone?" active":"")+"\\" onclick=\\"openConv(\\""+c.phone+"\\")\\">"\n' +
    '      +"<div class=\\"top\\"><span class=\\"phone\\">+"+esc(c.phone)+b+"</span><span class=\\"time\\">"+fmt(c.lastAt)+"</span></div>"\n' +
    '      +"<div class=\\"last\\">"+esc(c.lastText||"")+"</div></div>";\n' +
    '  }).join("");\n' +
    '}\n' +
    'async function openConv(phone){\n' +
    '  active=phone;\n' +
    '  var list=await api("/panel/api/conversations");\n' +
    '  var conv=null; for(var i=0;i<list.length;i++){if(list[i].phone===phone){conv=list[i];break;}}\n' +
    '  paused=!!(conv&&conv.paused);\n' +
    '  document.getElementById("chat").innerHTML=\n' +
    '    "<div id=\\"chathead\\"><span class=\\"phone\\">+"+esc(phone)+"</span>"\n' +
    '    +"<button id=\\"pauseBtn\\" class=\\""+(paused?"on":"")+"\\" onclick=\\"togglePause()\\">"+(paused?"Bot dijeda — aktifkan":"Jeda bot")+"</button></div>"\n' +
    '    +"<div id=\\"msgs\\"></div>"\n' +
    '    +"<div id=\\"composer\\"><input id=\\"box\\" placeholder=\\"Tulis balasan...\\" onkeydown=\\"if(event.key===\\\'Enter\\\'){sendMsg();}\\"/><button onclick=\\"sendMsg()\\">Kirim</button></div>";\n' +
    '  await loadMessages();\n' +
    '}\n' +
    'async function loadMessages(){\n' +
    '  if(!active) return;\n' +
    '  var msgs=await api("/panel/api/messages?to="+encodeURIComponent(active));\n' +
    '  var box=document.getElementById("msgs"); if(!box) return;\n' +
    '  box.innerHTML=msgs.map(function(m){\n' +
    '    return "<div class=\\"msg "+(m.direction==="out"?"out":"in")+"\\">"+esc(m.text)+"<div class=\\"t\\">"+fmt(m.timestamp)+"</div></div>";\n' +
    '  }).join("");\n' +
    '  box.scrollTop=box.scrollHeight;\n' +
    '}\n' +
    'async function sendMsg(){\n' +
    '  var input=document.getElementById("box"); if(!input) return;\n' +
    '  var text=input.value.trim(); if(!text||!active) return;\n' +
    '  input.value="";\n' +
    '  try{ await api("/panel/api/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({to:active,body:text})}); }\n' +
    '  catch(e){ alert("Gagal mengirim: "+e.message); }\n' +
    '  await loadMessages(); await loadConvs();\n' +
    '}\n' +
    'async function togglePause(){\n' +
    '  if(!active) return;\n' +
    '  paused=!paused;\n' +
    '  try{ await api("/panel/api/pause",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({to:active,paused:paused})}); }\n' +
    '  catch(e){ alert("Gagal mengubah jeda: "+e.message); paused=!paused; }\n' +
    '  var btn=document.getElementById("pauseBtn");\n' +
    '  if(btn){ btn.className=paused?"on":""; btn.textContent=paused?"Bot dijeda — aktifkan":"Jeda bot"; }\n' +
    '  await loadConvs();\n' +
    '}\n' +
    'loadConvs();\n' +
    'setInterval(function(){ loadConvs().catch(function(){}); if(active){ loadMessages().catch(function(){}); } }, 5000);\n' +
    '</script>\n' +
    '</body>\n' +
    '</html>';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/webhook' && request.method === 'GET') {
      return handleVerification(request, env);
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhookPost(request, env, ctx);
    }
    if (url.pathname === '/panel' && request.method === 'GET') {
      if (!checkPanelAuth(request, env)) return unauthorizedResponse();
      return new Response(panelHtml(), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    if (url.pathname.startsWith('/panel/api/')) {
      if (!checkPanelAuth(request, env)) return unauthorizedResponse();
      return handlePanelApi(request, env);
    }
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response('WhatsApp AI Bot Worker aktif. Webhook: /webhook, Panel: /panel', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
    return new Response('Not Found', { status: 404 });
  }
};
