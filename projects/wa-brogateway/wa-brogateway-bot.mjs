// wa-brogateway-bot.mjs
//
// Cloudflare Worker: balasan otomatis AI untuk WhatsApp Business lewat
// Bro Gateway (https://brogateway.com) — gateway WhatsApp Web berbasis
// REST API, tanpa Meta Business API dan tanpa verifikasi bisnis.
//
// Cara kerja:
// 1. Daftar di Bro Gateway (paket Free: 200 pesan/hari), tautkan nomor WA
//    Business lewat scan QR, lalu buat token API di dashboard.
// 2. Buat Worker baru di Cloudflare (mis. bot-wa), tempel file ini, atur
//    secret dan binding KV di bawah, lalu deploy.
// 3. Di dashboard Bro Gateway, atur webhook URL ke
//    https://<nama-worker>.<subdomain>.workers.dev/<WEBHOOK_PATH>
//    dan aktifkan event message.received.
// 4. Setiap ada pesan masuk, Bro Gateway mengirim event `message.received`
//    ke Worker ini; Worker membalas otomatis dengan AI (DeepSeek dulu,
//    Gemini sebagai cadangan), seperti bot Telegram.
//
// Yang perlu diatur di Cloudflare (Settings > Variables):
// - BRO_API_KEY (secret): token API dari dashboard Bro Gateway (wag_live_...).
// - WEBHOOK_PATH (secret): nilai acak untuk path webhook, supaya URL webhook
//   tidak bisa ditebak orang lain. Contoh nilai: 32 karakter hex acak.
// - WEBHOOK_SECRET (secret, opsional): kalau dashboard Bro Gateway
//   menampilkan secret saat menyimpan webhook, isi dengan nilai itu agar
//   Worker memverifikasi tanda tangan HMAC tiap kiriman. Tanpa ini, path
//   acak di atas adalah satu-satunya perlindungan webhook.
// - AI_API_KEY (secret, opsional): API key provider AI yang kompatibel
//   dengan OpenAI (mis. DeepSeek, termasuk key dari reseller).
// - AI_BASE_URL (opsional): base URL provider AI (default
//   https://api.deepseek.com).
// - AI_MODEL (opsional): nama model (default deepseek-chat).
// - GEMINI_API_KEY (secret, opsional): API key Gemini gratis dari Google AI
//   Studio, dipakai sebagai cadangan kalau provider utama gagal.
// - HISTORY_KV (binding KV Namespace, opsional): namespace KV untuk riwayat
//   percakapan, dedup, dan hitungan kuota harian. Bisa memakai namespace
//   yang sama dengan bot Telegram (key memakai prefix wa: jadi tidak
//   bentrok). Tanpa binding ini, riwayat hanya di memori Worker.
//
// Batasan (v1):
// - Hanya pesan teks yang dibalas; media, stiker, dan pesan grup diabaikan.
// - Tidak ada jeda otomatis saat pemilik membalas manual dari HP, karena
//   Bro Gateway tidak mengirim echo pesan yang dikirim dari aplikasi WA.
//   Sebagai pengaman, tiap pengirim dibalas maksimal sekali per menit.
// - Batas balasan 190/hari (paket Free Bro Gateway 200 pesan/hari).

// ---------------------------------------------------------------------------
// KONFIGURASI BALASAN — sesuaikan teks di bawah dengan kebutuhanmu.
// ---------------------------------------------------------------------------

export const CONFIG = {
  // Sapaan untuk pengirim yang baru pertama kali chat (dikirim sekali).
  greeting:
    "Halo! Terima kasih sudah menghubungi Rindou Store. Ini balasan otomatis — silakan tanya seputar produk kami ya.",

  // Balasan darurat kalau AI tidak aktif atau gagal.
  fallbackReply:
    "Siap, pesannya sudah kami terima. Pemilik toko akan membalas secepatnya ya.",

  // --- Balasan AI -----------------------------------------------------------
  ai: {
    enabled: true,
    model: "gemini-2.5-flash",
    temperature: 0.7,
    maxOutputTokens: 200,
    systemPrompt: [
      "Kamu adalah asisten customer service otomatis Rindou Store, sebuah toko online.",
      "Jawab dengan ramah dan santai dalam Bahasa Indonesia, 1-3 kalimat, seperti ngobrol biasa.",
      "Bantu pertanyaan seputar produk, pemesanan, pengiriman, dan toko.",
      "JANGAN mengarang harga, stok, alamat, jadwal, atau informasi lain yang tidak kamu ketahui.",
      "Kalau tidak tahu jawabannya, katakan dengan jujur bahwa kamu akan menanyakannya ke pemilik toko dan pemilik akan membalas secepatnya.",
      "Kalau ditanya hal di luar toko, jawab singkat secara umum.",
      "Kamu adalah asisten otomatis; jangan mengaku sebagai manusia atau sebagai pemilik toko.",
    ].join(" "),
    // Jumlah pesan terakhir per chat yang dikirim sebagai konteks.
    historyTurns: 6,
  },

  // Jeda minimum antar balasan ke pengirim yang sama (detik), supaya bot
  // tidak membalas berulang-ulang saat pelanggan mengirim banyak pesan.
  replyCooldownSeconds: 60,

  // Jeda minimum antar balasan fallback di chat yang sama (menit).
  fallbackCooldownMinutes: 5,

  // Pesan yang sudah lebih tua dari ini (menit) saat diterima tidak dibalas,
  // supaya bot tidak membalas pesan lama yang menumpuk saat nomor offline.
  // Hanya berlaku kalau webhook menyertakan waktu kirim pesan.
  staleMessageMinutes: 10,

  // Batas balasan per hari (paket Free Bro Gateway: 200 pesan/hari).
  dailyReplyCap: 190,

  // Masa berlaku riwayat chat di KV (detik).
  kvHistoryTtlSeconds: 24 * 60 * 60,

  // Masa berlaku penanda dedup di KV (detik).
  dedupTtlSeconds: 60 * 60,
};

// --- State -------------------------------------------------------------------

export function createState() {
  return {
    greetedSenders: new Set(), // nomor yang sudah disapa
    lastReply: new Map(), // nomor -> timestamp ms balasan terakhir
    lastFallback: new Map(), // nomor -> timestamp ms fallback terakhir
    processed: new Set(), // "wadedup:<messageId>" yang sudah diproses
    history: new Map(), // nomor -> [{ role: "user"|"model", text }]
  };
}

const state = createState();

function pushHistory(st, sender, role, text) {
  const list = st.history.get(sender) ?? [];
  list.push({ role, text });
  while (list.length > CONFIG.ai.historyTurns) list.shift();
  st.history.set(sender, list);
}

// --- Parsing webhook Bro Gateway --------------------------------------------
// Amplop event: { id, event, created_at, data: {...} }. Bentuk isi `data`
// untuk message.received tidak didokumentasikan lengkap di situs Bro Gateway,
// jadi parser ini menerima beberapa varian nama field yang umum dipakai
// gateway sejenis (from/sender, text/body/message) dan mengabaikan pesan
// yang tidak bisa dipahami, daripada menebak-nebak.

function parseTime(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (value > 1e12) return value; // epoch ms
    if (value > 1e9) return value * 1000; // epoch detik
    return null;
  }
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}

// Mengembalikan null kalau bukan event message.received, { skip } kalau
// event harus diabaikan, atau { messageId, from, text, sentAtMs }.
export function parseIncoming(envelope) {
  if (!envelope || envelope.event !== "message.received") return null;
  const data = envelope.data ?? {};

  // Pesan yang dikirim dari nomor sendiri (kalau gateway mengirim echo).
  if (data.from_me === true || data.direction === "outbound") {
    return { skip: "own_message" };
  }

  const chatId = data.chat_id ?? data.chatId ?? "";
  const fromRaw = data.from ?? data.sender ?? data.from_number ?? chatId ?? "";

  // Grup: ditandai is_group, atau chat/nomor berakhiran @g.us.
  const isGroup =
    data.is_group === true ||
    String(chatId).endsWith("@g.us") ||
    String(fromRaw).endsWith("@g.us");
  if (isGroup) return { skip: "group" };

  const rawText = data.text ?? data.body ?? data.message ?? data.content;
  const text = typeof rawText === "string" ? rawText : "";
  const messageId = data.message_id ?? data.id ?? envelope.id ?? null;
  const sentAtMs = parseTime(data.sent_at ?? data.timestamp ?? envelope.created_at);

  return { messageId, from: String(fromRaw), text, sentAtMs };
}

// Nomor tujuan untuk API kirim: hanya digit (buang suffix seperti
// @s.whatsapp.net). Bro Gateway menormalkan sendiri awalan 0/62.
export function normalizeRecipient(from) {
  return String(from).replace(/\D/g, "");
}

// --- Penyimpanan di Cloudflare KV -------------------------------------------
// Key: `wa:<nomor>` (riwayat), `wadedup:<messageId>` (dedup),
// `waquota:<YYYY-MM-DD>` (hitungan balasan harian). Semua fungsi aman
// dipanggil tanpa KV (no-op) dan tidak pernah melempar error.

function kvChatKey(sender) {
  return `wa:${sender}`;
}

function kvDedupKey(messageId) {
  return `wadedup:${messageId}`;
}

function kvQuotaKey(now) {
  const d = new Date(now);
  const ymd = [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
  return `waquota:${ymd}`;
}

export async function loadChatFromKv(kv, st, sender) {
  if (!kv) return;
  let data;
  try {
    data = await kv.get(kvChatKey(sender), "json");
  } catch (err) {
    console.error("KV get error:", err);
    return;
  }
  if (!data) return;
  if (data.greeted) st.greetedSenders.add(sender);
  if (Array.isArray(data.history)) st.history.set(sender, data.history);
  if (data.lastReply) st.lastReply.set(sender, data.lastReply);
  if (data.lastFallback) st.lastFallback.set(sender, data.lastFallback);
}

export async function saveChatToKv(kv, st, sender) {
  if (!kv) return;
  const data = {
    greeted: st.greetedSenders.has(sender),
    history: st.history.get(sender) ?? [],
    lastReply: st.lastReply.get(sender) ?? 0,
    lastFallback: st.lastFallback.get(sender) ?? 0,
  };
  try {
    await kv.put(kvChatKey(sender), JSON.stringify(data), {
      expirationTtl: CONFIG.kvHistoryTtlSeconds,
    });
  } catch (err) {
    console.error("KV put error:", err);
  }
}

// Klaim pesan sebagai "sedang/sudah diproses". Mengembalikan true kalau
// pesan ini duplikat (sudah pernah diklaim), false kalau baru diklaim.
// Dipanggil sebelum kerja AI, supaya kiriman ulang webhook yang datang
// saat pemrosesan pertama belum selesai tidak dibalas dua kali.
export async function claimDedup(kv, st, messageId) {
  if (!messageId) return false;
  const key = kvDedupKey(messageId);
  if (st.processed.has(key)) return true;
  if (kv) {
    try {
      if (await kv.get(key)) {
        st.processed.add(key);
        return true;
      }
      await kv.put(key, "1", { expirationTtl: CONFIG.dedupTtlSeconds });
    } catch (err) {
      console.error("KV dedup error:", err);
    }
  }
  if (st.processed.size > 5000) st.processed.clear();
  st.processed.add(key);
  return false;
}

export async function getDailyCount(kv, now) {
  if (!kv) return 0;
  try {
    return parseInt((await kv.get(kvQuotaKey(now))) ?? "0", 10) || 0;
  } catch (err) {
    console.error("KV quota get error:", err);
    return 0;
  }
}

export async function addDailyCount(kv, now, n) {
  if (!kv || n <= 0) return;
  try {
    const current = await getDailyCount(kv, now);
    await kv.put(kvQuotaKey(now), String(current + n), {
      expirationTtl: 48 * 60 * 60,
    });
  } catch (err) {
    console.error("KV quota put error:", err);
  }
}

// ctx: { send({to, text}), aiReply?({chatId, text, history}), state?, now?, kv? }
export async function handleEvent(envelope, ctx) {
  const st = ctx.state ?? state;
  const now = ctx.now ?? Date.now();

  const parsed = parseIncoming(envelope);
  if (!parsed) return { ok: true, action: "ignored" };
  if (parsed.skip) return { ok: true, action: parsed.skip };

  const { messageId, from, text, sentAtMs } = parsed;
  const to = normalizeRecipient(from);
  if (!to) return { ok: true, action: "ignored" };

  // Hanya pesan teks yang dibalas otomatis (v1).
  if (!text.trim()) return { ok: true, action: "ignored" };

  // Abaikan pesan lama (menumpuk saat nomor offline).
  if (sentAtMs && now - sentAtMs > CONFIG.staleMessageMinutes * 60_000) {
    return { ok: true, action: "stale" };
  }

  // Pulihkan data chat dari KV kalau belum ada di memori.
  if (!st.greetedSenders.has(to) && !st.history.has(to)) {
    await loadChatFromKv(ctx.kv, st, to);
  }

  // Dedup: jangan proses pesan yang sama dua kali.
  if (await claimDedup(ctx.kv, st, messageId)) {
    return { ok: true, action: "duplicate" };
  }

  const isNewSender = !st.greetedSenders.has(to);

  // Cooldown: catat pesannya sebagai konteks, tapi jangan balas dulu.
  const last = st.lastReply.get(to) ?? 0;
  if (!isNewSender && now - last < CONFIG.replyCooldownSeconds * 1000) {
    pushHistory(st, to, "user", text);
    await saveChatToKv(ctx.kv, st, to);
    return { ok: true, action: "cooldown" };
  }

  const replies = [];
  if (isNewSender) {
    replies.push(CONFIG.greeting);
    st.greetedSenders.add(to);
  }

  // Semua pesan dijawab AI. Kalau AI tidak aktif atau gagal, pakai balasan
  // fallback manual (hanya sebagai pengaman, bukan balasan biasa).
  let aiReply = null;
  if (CONFIG.ai.enabled && ctx.aiReply) {
    try {
      aiReply = await ctx.aiReply({
        chatId: to,
        text,
        history: st.history.get(to) ?? [],
      });
    } catch (err) {
      console.error("aiReply error:", err);
      aiReply = null;
    }
  }
  if (aiReply) {
    replies.push(aiReply);
  } else if (!isNewSender) {
    const lastFb = st.lastFallback.get(to) ?? 0;
    if (now - lastFb >= CONFIG.fallbackCooldownMinutes * 60_000) {
      replies.push(CONFIG.fallbackReply);
      st.lastFallback.set(to, now);
    }
  }

  // Simpan percakapan sebagai konteks untuk balasan AI berikutnya.
  pushHistory(st, to, "user", text);
  for (const reply of replies) pushHistory(st, to, "model", reply);
  await saveChatToKv(ctx.kv, st, to);

  // Jaga kuota harian paket Free: kirim hanya sebanyak sisa kuota.
  const used = await getDailyCount(ctx.kv, now);
  const remaining = CONFIG.dailyReplyCap - used;
  if (remaining <= 0) return { ok: true, action: "quota_exceeded", count: 0 };
  const toSend = replies.slice(0, remaining);

  let sent = 0;
  for (const reply of toSend) {
    await ctx.send({ to, text: reply });
    sent++;
  }
  if (sent) {
    st.lastReply.set(to, now);
    await addDailyCount(ctx.kv, now, sent);
    await saveChatToKv(ctx.kv, st, to);
  }
  return { ok: true, action: sent ? "replied" : "no_reply", count: sent };
}

// --- Balasan AI (sama seperti bot Telegram) ---------------------------------

export async function openaiReply(env, { history, text }, fetchFn = fetch) {
  const apiKey = env.AI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (env.AI_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  const url = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;
  const messages = [
    { role: "system", content: CONFIG.ai.systemPrompt },
    ...history.map((m) => ({
      role: m.role === "model" ? "assistant" : "user",
      content: m.text,
    })),
    { role: "user", content: text },
  ];
  let res;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: env.AI_MODEL || "deepseek-chat",
        messages,
        temperature: CONFIG.ai.temperature,
        max_tokens: CONFIG.ai.maxOutputTokens,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error("OpenAI-compatible request error:", err);
    return null;
  }
  if (!res.ok) {
    console.error("OpenAI-compatible API error:", res.status);
    return null;
  }
  const data = await res.json().catch(() => null);
  const reply = data?.choices?.[0]?.message?.content?.trim();
  return reply || null;
}

export async function geminiReply(env, { history, text }, fetchFn = fetch) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const raw = [...history, { role: "user", text }];
  const contents = [];
  for (const m of raw) {
    const last = contents[contents.length - 1];
    if (last && last.role === m.role) {
      last.parts[0].text += "\n" + m.text;
    } else {
      contents.push({ role: m.role, parts: [{ text: m.text }] });
    }
  }
  while (contents.length && contents[0].role !== "user") contents.shift();
  if (!contents.length) {
    contents.push({ role: "user", parts: [{ text }] });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.ai.model}:generateContent`;
  let res;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CONFIG.ai.systemPrompt }] },
        contents,
        generationConfig: {
          temperature: CONFIG.ai.temperature,
          maxOutputTokens: CONFIG.ai.maxOutputTokens,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error("Gemini request error:", err);
    return null;
  }
  if (!res.ok) {
    console.error("Gemini API error:", res.status);
    return null;
  }
  const data = await res.json().catch(() => null);
  const reply = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("")
    .trim();
  return reply || null;
}

export async function generateAiReply(env, args, fetchFn = fetch) {
  return (await openaiReply(env, args, fetchFn)) ?? (await geminiReply(env, args, fetchFn));
}

// --- Kirim pesan lewat Bro Gateway ------------------------------------------

export async function broGatewaySend(env, { to, text }, fetchFn = fetch) {
  const res = await fetchFn("https://brogateway.com/api/v1/messages/text", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.BRO_API_KEY,
    },
    body: JSON.stringify({ to, message: text }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Bro Gateway kirim gagal (${res.status}): ${data.error ?? data.message ?? "unknown"}`,
    );
  }
  return data;
}

// --- Verifikasi tanda tangan webhook ----------------------------------------
// Sesuai dokumentasi Bro Gateway: header x-signature berisi
// "sha256=" + hex(HMAC-SHA256(secret, timestamp + "." + rawBody)),
// dengan timestamp dari header x-timestamp.

export async function verifySignature(secret, timestamp, rawBody, signature) {
  if (!secret || !timestamp || !rawBody || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expected = `sha256=${hex}`;
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("WhatsApp Bot (Bro Gateway) aktif.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Path webhook rahasia: kalau WEBHOOK_PATH diatur, hanya path itu yang
    // diterima; path lain dijawab 404 supaya tidak ketahuan ada Worker.
    if (env.WEBHOOK_PATH && url.pathname !== `/${env.WEBHOOK_PATH}`) {
      return new Response("Not found", { status: 404 });
    }

    if (!env.BRO_API_KEY) {
      return Response.json({ ok: false, error: "BRO_API_KEY belum diatur" }, { status: 500 });
    }

    const rawBody = await request.text();

    if (env.WEBHOOK_SECRET) {
      const valid = await verifySignature(
        env.WEBHOOK_SECRET,
        request.headers.get("x-timestamp"),
        rawBody,
        request.headers.get("x-signature"),
      );
      if (!valid) {
        return Response.json({ ok: false, error: "signature tidak valid" }, { status: 401 });
      }
    }

    let envelope;
    try {
      envelope = JSON.parse(rawBody);
    } catch {
      return Response.json({ ok: false, error: "body bukan JSON" }, { status: 400 });
    }

    const work = handleEvent(envelope, {
      send: (args) => broGatewaySend(env, args),
      aiReply: (args) => generateAiReply(env, args),
      kv: env.HISTORY_KV,
    }).catch((err) => {
      console.error("handleEvent error:", err);
      return { ok: false, error: String(err) };
    });

    // Balas 200 segera supaya gateway tidak mengulang kiriman; kerja AI
    // dan kirim balasan berjalan di latar belakang.
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(work);
      return Response.json({ ok: true, action: "queued" });
    }
    return Response.json(await work);
  },
};
