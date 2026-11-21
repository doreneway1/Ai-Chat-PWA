// wa-bot-worker.mjs — Bot auto-reply WhatsApp (Cloud API) + AI di Cloudflare Worker.
//
// Cara kerja:
//   1. Meta mengirim pesan WA masuk ke webhook ini (POST /webhook).
//   2. Worker memverifikasi signature Meta, lalu membalas 200 secepatnya
//      (pekerjaan berat jalan di background lewat ctx.waitUntil supaya
//      Meta tidak menganggap webhook gagal dan mengirim ulang).
//   3. Worker memanggil AI (API yang kompatibel OpenAI, sama seperti yang
//      dipakai Orbit Chat) dan mengirim jawabannya lewat Cloud API.
//
// Yang perlu diisi sebagai Secrets / Variables di dashboard Cloudflare
// (Workers → worker ini → Settings → Variables):
//   WAJIB:
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

  await markAsRead(env, messageId);

  let reply;
  try {
    reply = await callAi(env, userText.slice(0, MAX_USER_MESSAGE_CHARS));
  } catch (error) {
    console.error('callAi gagal:', error?.message || error);
    reply = 'Maaf, saya sedang bermasalah sebentar. Coba kirim lagi beberapa saat ya.';
  }

  try {
    await sendWhatsAppText(env, from, reply);
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/webhook' && request.method === 'GET') {
      return handleVerification(request, env);
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhookPost(request, env, ctx);
    }
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response('WhatsApp AI Bot Worker aktif. Webhook: /webhook', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
    return new Response('Not Found', { status: 404 });
  }
};
