// telegram-business-bot.mjs
//
// Cloudflare Worker: bot Telegram Business untuk balasan otomatis di chat
// pribadi pemilik akun.
//
// Cara kerja:
// 1. Bot dibuat lewat @BotFather dan Secretary Mode diaktifkan
//    (dulu namanya Business Mode).
// 2. Bot dihubungkan ke akun Telegram lewat Settings > Telegram Business > Chatbots.
// 3. Telegram mengirim update `business_message` ke webhook Worker ini setiap
//    ada pesan di chat pribadi yang diizinkan.
// 4. Worker membalas otomatis (sebagai akun pemilik, bukan sebagai bot) sesuai
//    aturan di CONFIG di bawah.
//
// Yang perlu diatur di Cloudflare (Settings > Variables):
// - BOT_TOKEN (secret): token bot dari @BotFather.
// - WEBHOOK_SECRET (secret, opsional tapi disarankan): nilai yang sama dengan
//   parameter secret_token saat memanggil setWebhook.
// - GEMINI_API_KEY (secret, opsional): API key Gemini gratis dari Google AI
//   Studio, untuk balasan AI.
// - AI_API_KEY (secret, opsional): API key provider AI yang kompatibel dengan
//   OpenAI (mis. DeepSeek, termasuk key dari reseller).
// - AI_BASE_URL (opsional): base URL provider AI (default
//   https://api.deepseek.com).
// - AI_MODEL (opsional): nama model (default deepseek-chat).
// - HISTORY_KV (binding KV Namespace, opsional): namespace KV untuk menyimpan
//   riwayat percakapan supaya bot tetap ingat setelah Worker restart (TTL 24
//   jam per chat). Buat di dashboard: Workers & Pages > KV > Create namespace,
//   lalu sambungkan di Worker Settings > Variables > KV Namespace Bindings
//   dengan nama variabel HISTORY_KV. Tanpa binding ini, riwayat hanya di
//   memori Worker.
// Provider OpenAI-compatible dipakai dulu; kalau gagal, bot mencoba Gemini.
// Tanpa keduanya, bot memakai balasan manual saja.
//
// Batasan Telegram:
// - Bot hanya bisa membalas chat yang ada pesan masuk dalam 24 jam terakhir.
// - Bot tidak bisa memulai percakapan.
// - Pesan balasan dikirim sebagai akun pemilik, bukan sebagai bot.

// ---------------------------------------------------------------------------
// KONFIGURASI BALASAN — sesuaikan teks di bawah dengan kebutuhanmu.
// ---------------------------------------------------------------------------

export const CONFIG = {
  // Sapaan untuk orang yang baru pertama kali chat (dikirim sekali per chat).
  greeting: "Halo! Makasih udah chat ya. Silakan tanya apa aja.",

  // Balasan darurat kalau AI tidak aktif atau gagal. Dalam mode AI-only ini
  // hanya dipakai saat AI bermasalah, bukan sebagai balasan biasa.
  fallbackReply:
    "Siap, pesannya udah kuterima. Nanti dibalas ya kalau udah sempat.",

  // --- Balasan AI -----------------------------------------------------------
  // Semua pesan dijawab AI supaya jawabannya bervariasi dan nyambung.
  // Bot berperan sebagai asisten pribadi yang santai: menjawab secara umum
  // sesuai topik, tidak mengarahkan ke produk/toko, dan kalau ditanya soal
  // pemilik akun, menjelaskan bahwa pemilik sedang sibuk dan akan membalas
  // kalau sudah ada waktu.
  ai: {
    enabled: true,
    // Model Gemini (tier gratis). Ganti kalau mau model lain.
    model: "gemini-2.5-flash",
    temperature: 0.7,
    maxOutputTokens: 200,
    // Instruksi untuk AI. Sesuaikan dengan kebutuhanmu di sini.
    systemPrompt: [
      "Kamu adalah asisten pribadi pemilik akun Telegram ini.",
      "Jawab dengan santai dan ramah dalam Bahasa Indonesia, 1-3 kalimat, seperti ngobrol biasa.",
      "Jawab secara umum sesuai topik yang ditanyakan; jangan mengarahkan pembicaraan ke produk atau toko kecuali lawan bicara yang membahasnya duluan.",
      "Kalau ditanya tentang pemilik akun (misalnya di mana, sibuk atau tidak, kapan dibalas), jelaskan bahwa pemilik sedang sibuk dan akan membalas kalau sudah ada waktu.",
      "Jangan mengarang informasi tentang pemilik, harga, stok, alamat, atau hal lain yang tidak kamu ketahui.",
      "Kalau tidak tahu jawabannya, katakan dengan jujur dan tawarkan bantuan lain.",
    ].join(" "),
    // Jumlah pesan terakhir per chat yang dikirim sebagai konteks.
    historyTurns: 6,
  },

  // Setelah pemilik membalas sendiri di sebuah chat, balasan otomatis dijeda
  // selama ini (menit) supaya bot tidak menimpa percakapan manusia.
  humanTakeoverMinutes: 30,

  // Jeda minimum antar balasan fallback di chat yang sama (menit), supaya bot
  // tidak membalas berulang-ulang saat pelanggan mengirim banyak pesan.
  fallbackCooldownMinutes: 5,

  // Masa berlaku riwayat chat di KV (detik). Riwayat tiap chat terhapus
  // otomatis setelah sekian detik tanpa pesan baru. Hanya berlaku kalau
  // binding HISTORY_KV diatur.
  kvHistoryTtlSeconds: 24 * 60 * 60,
};

// --- State -------------------------------------------------------------------
// State utama di memori Worker. Kalau binding HISTORY_KV diatur, data per-chat
// (sapaan, riwayat, jeda) juga disimpan di KV dan dipulihkan saat Worker
// restart, jadi bot tetap ingat percakapan.

export function createState() {
  return {
    greetedChats: new Set(), // chatId yang sudah disapa
    humanUntil: new Map(), // chatId -> timestamp ms berakhirnya jeda
    lastFallback: new Map(), // chatId -> timestamp ms fallback terakhir
    processed: new Set(), // "chatId:messageId" yang sudah diproses
    history: new Map(), // chatId -> [{ role: "user"|"model", text }]
  };
}

const state = createState();

function isCustomerMessage(msg) {
  // Di chat pribadi, chat.id adalah user id lawan bicara (pelanggan).
  // Kalau pengirimnya bukan lawan bicara, berarti itu pesan dari pemilik akun.
  return msg.chat?.type === "private" && msg.from?.id === msg.chat.id;
}

function pushHistory(st, chatId, role, text) {
  const list = st.history.get(chatId) ?? [];
  list.push({ role, text });
  while (list.length > CONFIG.ai.historyTurns) list.shift();
  st.history.set(chatId, list);
}

// --- Penyimpanan riwayat di Cloudflare KV -----------------------------------
// Key: `chat:<chatId>`, value JSON: { greeted, history, lastFallback, humanUntil }.
// `kv` adalah binding KVNamespace (env.HISTORY_KV) atau undefined kalau tidak
// diatur; semua fungsi di sini aman dipanggil tanpa KV (no-op) dan tidak
// pernah melempar error (kegagalan KV hanya dicatat di log).
function kvKey(chatId) {
  return `chat:${chatId}`;
}

export async function loadChatFromKv(kv, st, chatId) {
  if (!kv) return;
  let data;
  try {
    data = await kv.get(kvKey(chatId), "json");
  } catch (err) {
    console.error("KV get error:", err);
    return;
  }
  if (!data) return;
  if (data.greeted) st.greetedChats.add(chatId);
  if (Array.isArray(data.history)) st.history.set(chatId, data.history);
  if (data.lastFallback) st.lastFallback.set(chatId, data.lastFallback);
  if (data.humanUntil) st.humanUntil.set(chatId, data.humanUntil);
}

export async function saveChatToKv(kv, st, chatId) {
  if (!kv) return;
  const data = {
    greeted: st.greetedChats.has(chatId),
    history: st.history.get(chatId) ?? [],
    lastFallback: st.lastFallback.get(chatId) ?? 0,
    humanUntil: st.humanUntil.get(chatId) ?? 0,
  };
  try {
    await kv.put(kvKey(chatId), JSON.stringify(data), {
      expirationTtl: CONFIG.kvHistoryTtlSeconds,
    });
  } catch (err) {
    console.error("KV put error:", err);
  }
}

// ctx: { send({businessConnectionId, chatId, text}), aiReply?({chatId, text, history}), state?, now?, kv? }
// `state`, `now`, `aiReply`, dan `kv` bisa di-inject untuk tes; defaultnya
// state modul, Date.now(), tanpa AI, dan tanpa KV.
export async function handleUpdate(update, ctx) {
  const st = ctx.state ?? state;
  const now = ctx.now ?? Date.now();

  if (update.business_connection) {
    // Bot dihubungkan/diputus dari akun bisnis. Tidak ada aksi yang diperlukan.
    return { ok: true, action: "business_connection" };
  }

  const msg = update.business_message;
  if (!msg) return { ok: true, action: "ignored" };

  // Hanya chat pribadi yang diproses.
  if (msg.chat?.type !== "private") return { ok: true, action: "ignored" };
  // Abaikan pesan dari bot lain.
  if (msg.from?.is_bot) return { ok: true, action: "ignored" };

  const chatId = msg.chat.id;

  // Pulihkan data chat dari KV kalau belum ada di memori (mis. setelah Worker
  // restart). Kalau chat sudah dikenal di memori, data memori yang dipakai.
  if (!st.greetedChats.has(chatId) && !st.history.has(chatId)) {
    await loadChatFromKv(ctx.kv, st, chatId);
  }

  // Pesan dari pemilik akun sendiri -> jeda balasan otomatis di chat ini.
  if (!isCustomerMessage(msg)) {
    st.humanUntil.set(chatId, now + CONFIG.humanTakeoverMinutes * 60_000);
    await saveChatToKv(ctx.kv, st, chatId);
    return { ok: true, action: "human_takeover" };
  }

  // Dedup: jangan proses pesan yang sama dua kali.
  const dedupKey = `${chatId}:${msg.message_id}`;
  if (st.processed.has(dedupKey)) return { ok: true, action: "duplicate" };
  if (st.processed.size > 5000) st.processed.clear();
  st.processed.add(dedupKey);

  // Balasan otomatis sedang dijeda karena pemilik baru saja membalas.
  if ((st.humanUntil.get(chatId) ?? 0) > now) {
    return { ok: true, action: "paused" };
  }

  // Hanya pesan teks yang dibalas otomatis (v1).
  const text = msg.text;
  if (!text) return { ok: true, action: "ignored" };

  const replies = [];
  const isNewChat = !st.greetedChats.has(chatId);
  if (isNewChat) {
    replies.push(CONFIG.greeting);
    st.greetedChats.add(chatId);
  }

  // Semua pesan dijawab AI. Kalau AI tidak aktif atau gagal, pakai balasan
  // fallback manual (hanya sebagai pengaman, bukan balasan biasa).
  let aiReply = null;
  if (CONFIG.ai.enabled && ctx.aiReply) {
    try {
      aiReply = await ctx.aiReply({
        chatId,
        text,
        history: st.history.get(chatId) ?? [],
      });
    } catch (err) {
      console.error("aiReply error:", err);
      aiReply = null;
    }
  }
  if (aiReply) {
    replies.push(aiReply);
  } else if (!isNewChat) {
    // Chat lama dan AI tidak tersedia: kirim fallback (dengan cooldown).
    const last = st.lastFallback.get(chatId) ?? 0;
    if (now - last >= CONFIG.fallbackCooldownMinutes * 60_000) {
      replies.push(CONFIG.fallbackReply);
      st.lastFallback.set(chatId, now);
    }
  }

  // Simpan percakapan sebagai konteks untuk balasan AI berikutnya.
  pushHistory(st, chatId, "user", text);
  for (const reply of replies) pushHistory(st, chatId, "model", reply);

  // Simpan data chat ke KV supaya riwayat bertahan setelah Worker restart.
  await saveChatToKv(ctx.kv, st, chatId);

  const businessConnectionId = msg.business_connection_id;
  for (const reply of replies) {
    await ctx.send({ businessConnectionId, chatId, text: reply });
  }
  return { ok: true, action: replies.length ? "replied" : "no_reply", count: replies.length };
}

// Minta balasan AI ke provider yang kompatibel dengan OpenAI (mis. DeepSeek,
// termasuk lewat base URL reseller). Mengembalikan string balasan, atau null
// kalau tidak dikonfigurasi / gagal. `fetchFn` bisa di-inject untuk tes.
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

// Rantai balasan AI: coba provider OpenAI-compatible dulu (DeepSeek),
// lalu Gemini sebagai cadangan. Mengembalikan null kalau keduanya gagal.
export async function generateAiReply(env, args, fetchFn = fetch) {
  return (await openaiReply(env, args, fetchFn)) ?? (await geminiReply(env, args, fetchFn));
}

// Minta balasan AI ke Gemini. Mengembalikan string balasan, atau null kalau
// API key tidak ada, request gagal, atau respons kosong (caller lalu memakai
// balasan fallback manual). `fetchFn` bisa di-inject untuk tes.
export async function geminiReply(env, { history, text }, fetchFn = fetch) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return null;

  // Susun konteks: gabungkan pesan berurutan dengan peran yang sama (Gemini
  // minta peran bergantian) dan pastikan pesan pertama dari user.
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

async function telegramSend(env, { businessConnectionId, chatId, text }) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      business_connection_id: businessConnectionId,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram sendMessage gagal (${res.status}): ${data.description ?? "unknown"}`);
  }
  return data;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Telegram Business Bot aktif.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (!env.BOT_TOKEN) {
      return Response.json({ ok: false, error: "BOT_TOKEN belum diatur" }, { status: 500 });
    }

    if (env.WEBHOOK_SECRET) {
      const header = request.headers.get("x-telegram-bot-api-secret-token");
      if (header !== env.WEBHOOK_SECRET) {
        return Response.json({ ok: false, error: "secret token tidak cocok" }, { status: 401 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return Response.json({ ok: false, error: "body bukan JSON" }, { status: 400 });
    }

    try {
      const result = await handleUpdate(update, {
        send: (args) => telegramSend(env, args),
        aiReply: (args) => generateAiReply(env, args),
        kv: env.HISTORY_KV,
      });
      return Response.json(result);
    } catch (err) {
      console.error("handleUpdate error:", err);
      return Response.json({ ok: false, error: String(err) }, { status: 200 });
    }
  },
};
