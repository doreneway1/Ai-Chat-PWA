// Tes untuk telegram-business-bot.mjs
// Jalankan: node --test telegram-business-bot.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { handleUpdate, createState, CONFIG, geminiReply, openaiReply, generateAiReply, ownerNotifyText } from "./telegram-business-bot.mjs";

const T0 = 1_000_000;

function makeCtx(state, now = T0, aiReply) {
  const sent = [];
  return {
    ctx: { state, now, aiReply, send: async (args) => sent.push(args) },
    sent,
  };
}

function customerMsg({ chatId = 111, messageId = 1, text = "permisi", connectionId = "conn-1" } = {}) {
  return {
    business_message: {
      message_id: messageId,
      business_connection_id: connectionId,
      from: { id: chatId, is_bot: false, first_name: "Andi" },
      chat: { id: chatId, type: "private" },
      text,
    },
  };
}

function ownerMsg({ chatId = 111, messageId = 50, text = "baik" } = {}) {
  return {
    business_message: {
      message_id: messageId,
      business_connection_id: "conn-1",
      from: { id: 999, is_bot: false }, // id pemilik != id chat
      chat: { id: chatId, type: "private" },
      text,
    },
  };
}

// KV palsu untuk tes: get/put seperti KVNamespace asli.
function createFakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  return {
    store,
    puts,
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value, opts) {
      store.set(key, value);
      puts.push({ key, value, opts });
    },
  };
}

test("business_connection dicatat tanpa mengirim apa pun", async () => {
  const { ctx, sent } = makeCtx(createState());
  const res = await handleUpdate(
    { business_connection: { id: "conn-1", user: { id: 999 }, status: "enabled" } },
    ctx,
  );
  assert.equal(res.action, "business_connection");
  assert.equal(sent.length, 0);
});

test("pesan pertama pelanggan mendapat sapaan", async () => {
  const { ctx, sent } = makeCtx(createState());
  const res = await handleUpdate(customerMsg({ text: "permisi" }), ctx);
  assert.equal(res.action, "replied");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, CONFIG.greeting);
  assert.equal(sent[0].chatId, 111);
  assert.equal(sent[0].businessConnectionId, "conn-1");
});

test("pesan pertama dijawab sapaan + AI", async () => {
  const aiReply = async () => "Balasan AI contoh.";
  const { ctx, sent } = makeCtx(createState(), T0, aiReply);
  await handleUpdate(customerMsg({ text: "berapa harganya?" }), ctx);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, CONFIG.greeting);
  assert.equal(sent[1].text, "Balasan AI contoh.");
});

test("pesan pertama 'halo' hanya dibalas sapaan (tidak dobel halo)", async () => {
  const { ctx, sent } = makeCtx(createState());
  await handleUpdate(customerMsg({ text: "halo" }), ctx);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, CONFIG.greeting);
});

test("chat lama dijawab AI saja", async () => {
  const state = createState();
  const first = makeCtx(state);
  await handleUpdate(customerMsg({ messageId: 1, text: "permisi" }), first.ctx);
  const aiReply = async () => "Balasan AI contoh.";
  const second = makeCtx(state, T0, aiReply);
  await handleUpdate(customerMsg({ messageId: 2, text: "stoknya ready?" }), second.ctx);
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].text, "Balasan AI contoh.");
});

test("chat lama tanpa kata kunci dibalas fallback, lalu cooldown", async () => {
  const state = createState();
  const first = makeCtx(state);
  await handleUpdate(customerMsg({ messageId: 1, text: "permisi" }), first.ctx);

  const second = makeCtx(state);
  await handleUpdate(customerMsg({ messageId: 2, text: "ok sip" }), second.ctx);
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].text, CONFIG.fallbackReply);

  const third = makeCtx(state);
  await handleUpdate(customerMsg({ messageId: 3, text: "oke deh" }), third.ctx);
  assert.equal(third.sent.length, 0); // masih dalam cooldown 5 menit

  const later = makeCtx(state, T0 + 6 * 60_000);
  await handleUpdate(customerMsg({ messageId: 4, text: "oke deh" }), later.ctx);
  assert.equal(later.sent.length, 1); // cooldown habis
});

test("pesan pemilik menjeda balasan otomatis 30 menit", async () => {
  const state = createState();
  const first = makeCtx(state);
  await handleUpdate(customerMsg({ messageId: 1, text: "permisi" }), first.ctx);

  const owner = makeCtx(state);
  const ownerRes = await handleUpdate(ownerMsg({ messageId: 50 }), owner.ctx);
  assert.equal(ownerRes.action, "human_takeover");
  assert.equal(owner.sent.length, 0);

  const paused = makeCtx(state);
  const pausedRes = await handleUpdate(customerMsg({ messageId: 2, text: "berapa harganya?" }), paused.ctx);
  assert.equal(pausedRes.action, "paused");
  assert.equal(paused.sent.length, 0);

  const after = makeCtx(state, T0 + 31 * 60_000);
  await handleUpdate(customerMsg({ messageId: 3, text: "berapa harganya?" }), after.ctx);
  assert.equal(after.sent.length, 1); // jeda habis, bot balas lagi
});

test("pesan yang sama dua kali hanya dibalas sekali (dedup)", async () => {
  const { ctx, sent } = makeCtx(createState());
  const update = customerMsg({ messageId: 7, text: "permisi" });
  await handleUpdate(update, ctx);
  const res = await handleUpdate(update, ctx);
  assert.equal(res.action, "duplicate");
  assert.equal(sent.length, 1);
});

test("pesan tanpa teks (mis. foto) diabaikan", async () => {
  const { ctx, sent } = makeCtx(createState());
  const update = customerMsg({ text: undefined });
  delete update.business_message.text;
  const res = await handleUpdate(update, ctx);
  assert.equal(res.action, "ignored");
  assert.equal(sent.length, 0);
});

test("pesan dari bot lain diabaikan", async () => {
  const { ctx, sent } = makeCtx(createState());
  const update = customerMsg({ text: "halo" });
  update.business_message.from.is_bot = true;
  const res = await handleUpdate(update, ctx);
  assert.equal(res.action, "ignored");
  assert.equal(sent.length, 0);
});

test("pesan grup diabaikan", async () => {
  const { ctx, sent } = makeCtx(createState());
  const update = customerMsg({ text: "halo" });
  update.business_message.chat.type = "group";
  const res = await handleUpdate(update, ctx);
  assert.equal(res.action, "ignored");
  assert.equal(sent.length, 0);
});

test("update lain (mis. message biasa) diabaikan", async () => {
  const { ctx, sent } = makeCtx(createState());
  const res = await handleUpdate({ message: { message_id: 1, text: "hi" } }, ctx);
  assert.equal(res.action, "ignored");
  assert.equal(sent.length, 0);
});

test("pesan tanpa kata kunci dijawab AI", async () => {
  const state = createState();
  const first = makeCtx(state);
  await handleUpdate(customerMsg({ messageId: 1, text: "permisi" }), first.ctx);

  const aiCalls = [];
  const aiReply = async (args) => {
    // Salin riwayat: array aslinya berubah lagi setelah aiReply dipanggil.
    aiCalls.push({ ...args, history: [...args.history] });
    return "Balasan AI contoh.";
  };
  const second = makeCtx(state, T0, aiReply);
  await handleUpdate(customerMsg({ messageId: 2, text: "kamu jual apa saja?" }), second.ctx);
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].text, "Balasan AI contoh.");
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].text, "kamu jual apa saja?");
});

test("AI gagal -> balasan fallback manual", async () => {
  const state = createState();
  const first = makeCtx(state);
  await handleUpdate(customerMsg({ messageId: 1, text: "permisi" }), first.ctx);

  const aiReply = async () => {
    throw new Error("AI down");
  };
  const second = makeCtx(state, T0, aiReply);
  await handleUpdate(customerMsg({ messageId: 2, text: "kamu jual apa saja?" }), second.ctx);
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].text, CONFIG.fallbackReply);
});

test("AI mengembalikan kosong -> balasan fallback manual", async () => {
  const state = createState();
  const first = makeCtx(state);
  await handleUpdate(customerMsg({ messageId: 1, text: "permisi" }), first.ctx);

  const second = makeCtx(state, T0, async () => null);
  await handleUpdate(customerMsg({ messageId: 2, text: "kamu jual apa saja?" }), second.ctx);
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].text, CONFIG.fallbackReply);
});

test("riwayat percakapan diteruskan ke AI", async () => {
  const state = createState();
  const aiCalls = [];
  const aiReply = async (args) => {
    aiCalls.push(args);
    return `AI: ${args.text}`;
  };
  const first = makeCtx(state, T0, aiReply);
  await handleUpdate(customerMsg({ messageId: 1, text: "permisi" }), first.ctx);
  const second = makeCtx(state, T0, aiReply);
  await handleUpdate(customerMsg({ messageId: 2, text: "ada warna merah?" }), second.ctx);
  assert.equal(aiCalls.length, 2);
  const history = aiCalls[1].history;
  assert.ok(history.some((m) => m.role === "user" && m.text === "permisi"));
  assert.ok(history.some((m) => m.role === "model"));
});

test("geminiReply mem-parsing respons Gemini", async () => {
  const fakeFetch = async (url, init) => {
    assert.match(url, /gemini-2\.5-flash/);
    assert.equal(init.headers["x-goog-api-key"], "test-key");
    const body = JSON.parse(init.body);
    assert.equal(body.contents.at(-1).parts[0].text, "halo");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Halo juga!" }] } }],
      }),
    };
  };
  const reply = await geminiReply(
    { GEMINI_API_KEY: "test-key" },
    { history: [], text: "halo" },
    fakeFetch,
  );
  assert.equal(reply, "Halo juga!");
});

test("geminiReply mengembalikan null saat API error atau key tidak ada", async () => {
  const failingFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(
    await geminiReply({ GEMINI_API_KEY: "test-key" }, { history: [], text: "halo" }, failingFetch),
    null,
  );
  assert.equal(await geminiReply({}, { history: [], text: "halo" }, failingFetch), null);
});

test("geminiReply menggabungkan pesan berurutan dengan peran sama", async () => {
  let sentBody;
  const fakeFetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
    };
  };
  const history = [
    { role: "user", text: "permisi" },
    { role: "model", text: "sapaan" },
    { role: "model", text: "jawaban" },
  ];
  await geminiReply({ GEMINI_API_KEY: "k" }, { history, text: "lanjut" }, fakeFetch);
  const roles = sentBody.contents.map((c) => c.role);
  assert.deepEqual(roles, ["user", "model", "user"]);
  assert.equal(sentBody.contents[0].role, "user");
});

test("openaiReply mem-parsing respons chat completions", async () => {
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(init.headers.authorization, "Bearer test-key");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "deepseek-chat");
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages.at(-1).content, "halo");
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Halo juga!" } }] }),
    };
  };
  const reply = await openaiReply(
    { AI_API_KEY: "test-key" },
    { history: [], text: "halo" },
    fakeFetch,
  );
  assert.equal(reply, "Halo juga!");
});

test("openaiReply memetakan peran model ke assistant dan memakai base URL custom", async () => {
  let sentBody;
  let sentUrl;
  const fakeFetch = async (url, init) => {
    sentUrl = url;
    sentBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    };
  };
  await openaiReply(
    { AI_API_KEY: "k", AI_BASE_URL: "https://reseller.example.com/v1/", AI_MODEL: "deepseek-reasoner" },
    { history: [{ role: "user", text: "hai" }, { role: "model", text: "halo" }], text: "lanjut" },
    fakeFetch,
  );
  assert.equal(sentUrl, "https://reseller.example.com/v1/chat/completions");
  assert.equal(sentBody.model, "deepseek-reasoner");
  const roles = sentBody.messages.map((m) => m.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
});

test("openaiReply mengembalikan null tanpa key atau saat API error", async () => {
  const failingFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  assert.equal(
    await openaiReply({ AI_API_KEY: "k" }, { history: [], text: "halo" }, failingFetch),
    null,
  );
  assert.equal(await openaiReply({}, { history: [], text: "halo" }, failingFetch), null);
});

test("generateAiReply memakai Gemini sebagai cadangan kalau DeepSeek gagal", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes("deepseek")) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "Dari Gemini." }] } }] }),
    };
  };
  const reply = await generateAiReply(
    { AI_API_KEY: "k", GEMINI_API_KEY: "g" },
    { history: [], text: "halo" },
    fakeFetch,
  );
  assert.equal(reply, "Dari Gemini.");
  assert.equal(calls.length, 2);
});

test("generateAiReply tidak memanggil Gemini kalau DeepSeek berhasil", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Dari DeepSeek." } }] }),
    };
  };
  const reply = await generateAiReply(
    { AI_API_KEY: "k", GEMINI_API_KEY: "g" },
    { history: [], text: "halo" },
    fakeFetch,
  );
  assert.equal(reply, "Dari DeepSeek.");
  assert.equal(calls.length, 1);
});

test("riwayat dipulihkan dari KV setelah restart (state baru)", async () => {
  const kv = createFakeKv({
    "chat:111": JSON.stringify({
      greeted: true,
      history: [
        { role: "user", text: "kemarin aku tanya harga" },
        { role: "model", text: "siap, aku cek dulu" },
      ],
      lastFallback: 0,
      humanUntil: 0,
    }),
  });
  const state = createState(); // state baru = simulasi Worker restart
  const aiCalls = [];
  const aiReply = async (args) => {
    // Salin riwayat: array aslinya berubah lagi setelah aiReply dipanggil.
    aiCalls.push({ ...args, history: [...args.history] });
    return "Balasan AI contoh.";
  };
  const { ctx, sent } = makeCtx(state, T0, aiReply);
  ctx.kv = kv;
  await handleUpdate(customerMsg({ messageId: 9, text: "lanjut" }), ctx);
  assert.equal(sent.length, 1); // tidak disapa lagi
  assert.equal(sent[0].text, "Balasan AI contoh.");
  assert.equal(aiCalls[0].history.length, 2);
  assert.ok(aiCalls[0].history.some((m) => m.text === "kemarin aku tanya harga"));
});

test("riwayat disimpan ke KV setelah membalas, dengan TTL 24 jam", async () => {
  const kv = createFakeKv();
  const state = createState();
  const { ctx, sent } = makeCtx(state, T0, async () => "Balasan AI contoh.");
  ctx.kv = kv;
  await handleUpdate(customerMsg({ messageId: 1, text: "permisi" }), ctx);
  assert.equal(sent.length, 2);
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0].key, "chat:111");
  assert.equal(kv.puts[0].opts.expirationTtl, 24 * 60 * 60);
  const saved = JSON.parse(kv.puts[0].value);
  assert.equal(saved.greeted, true);
  assert.ok(saved.history.some((m) => m.role === "user" && m.text === "permisi"));
});

test("bot tetap jalan kalau KV error", async () => {
  const badKv = {
    get: async () => { throw new Error("kv down"); },
    put: async () => { throw new Error("kv down"); },
  };
  const state = createState();
  const { ctx, sent } = makeCtx(state, T0, async () => "Balasan AI contoh.");
  ctx.kv = badKv;
  const res = await handleUpdate(customerMsg({ messageId: 1, text: "permisi" }), ctx);
  assert.equal(res.action, "replied");
  assert.equal(sent.length, 2);
});

test("systemPrompt: asisten pribadi santai, bukan CS toko", () => {
  assert.match(CONFIG.ai.systemPrompt, /asisten pribadi/);
  assert.match(CONFIG.ai.systemPrompt, /santai/);
  assert.match(CONFIG.ai.systemPrompt, /sibuk/);
  assert.match(CONFIG.ai.systemPrompt, /jangan mengarahkan pembicaraan ke produk/);
});

test("pemilik diberi tahu saat bot membalas", async () => {
  const notified = [];
  const state = createState();
  const { ctx, sent } = makeCtx(state, T0, async () => "Balasan AI contoh.");
  ctx.notifyOwner = async (text) => notified.push(text);
  await handleUpdate(customerMsg({ messageId: 1, text: "berapa harganya?" }), ctx);
  assert.equal(sent.length, 2);
  assert.equal(notified.length, 1);
  assert.match(notified[0], /Andi/);
  assert.match(notified[0], /berapa harganya\?/);
  assert.match(notified[0], /Balasan AI contoh\./);
});

test("pemilik tidak diberi tahu kalau bot tidak membalas", async () => {
  const notified = [];
  const state = createState();
  const first = makeCtx(state);
  await handleUpdate(customerMsg({ messageId: 1, text: "permisi" }), first.ctx);

  const owner = makeCtx(state);
  await handleUpdate(ownerMsg({ messageId: 50 }), owner.ctx);

  const paused = makeCtx(state, T0, async () => "Balasan AI contoh.");
  paused.ctx.notifyOwner = async (text) => notified.push(text);
  const res = await handleUpdate(customerMsg({ messageId: 2, text: "berapa harganya?" }), paused.ctx);
  assert.equal(res.action, "paused");
  assert.equal(notified.length, 0);
});

test("ownerNotifyText memotong balasan bot yang panjang", () => {
  const text = ownerNotifyText({
    senderName: "Andi",
    text: "halo",
    replies: ["x".repeat(1000)],
  });
  assert.ok(text.length <= 4000);
  assert.match(text, /…/);
  assert.match(text, /Andi/);
});

test("notifikasi gagal tidak menggagalkan balasan", async () => {
  const state = createState();
  const { ctx, sent } = makeCtx(state, T0, async () => "Balasan AI contoh.");
  ctx.notifyOwner = async () => { throw new Error("notify down"); };
  const res = await handleUpdate(customerMsg({ messageId: 1, text: "permisi" }), ctx);
  assert.equal(res.action, "replied");
  assert.equal(sent.length, 2);
});

test("/start dari pemilik dibalas konfirmasi", async () => {
  const notified = [];
  const { ctx } = makeCtx(createState());
  ctx.ownerChatId = "999";
  ctx.notifyOwner = async (text) => notified.push(text);
  const res = await handleUpdate(
    { message: { message_id: 1, from: { id: 999 }, chat: { id: 999, type: "private" }, text: "/start" } },
    ctx,
  );
  assert.equal(res.action, "start");
  assert.equal(notified.length, 1);
  assert.match(notified[0], /Notifikasi aktif/);
});

test("/start dari orang lain diabaikan", async () => {
  const notified = [];
  const { ctx } = makeCtx(createState());
  ctx.ownerChatId = "999";
  ctx.notifyOwner = async (text) => notified.push(text);
  const res = await handleUpdate(
    { message: { message_id: 1, from: { id: 111 }, chat: { id: 111, type: "private" }, text: "/start" } },
    ctx,
  );
  assert.equal(res.action, "ignored");
  assert.equal(notified.length, 0);
});

test("/start tanpa ownerChatId diabaikan", async () => {
  const notified = [];
  const { ctx } = makeCtx(createState());
  ctx.notifyOwner = async (text) => notified.push(text);
  const res = await handleUpdate(
    { message: { message_id: 1, from: { id: 999 }, chat: { id: 999, type: "private" }, text: "/start" } },
    ctx,
  );
  assert.equal(res.action, "ignored");
  assert.equal(notified.length, 0);
});
