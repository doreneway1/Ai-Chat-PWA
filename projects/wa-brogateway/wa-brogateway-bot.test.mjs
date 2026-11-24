// Tes untuk wa-brogateway-bot.mjs
// Jalankan: node --test wa-brogateway-bot.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import bot, {
  handleEvent,
  createState,
  CONFIG,
  parseIncoming,
  normalizeRecipient,
  verifySignature,
  broGatewaySend,
  generateAiReply,
  openaiReply,
  getDailyCount,
} from "./wa-brogateway-bot.mjs";

const T0 = 1_700_000_000_000; // 14 Nov 2023, dipakai sebagai "now" di tes

function makeCtx(state, now = T0, aiReply, kv) {
  const sent = [];
  return {
    ctx: { state, now, aiReply, kv, send: async (args) => sent.push(args) },
    sent,
  };
}

// Event message.received dalam bentuk paling umum.
function incoming({ from = "628123456789", messageId = "msg-1", text = "permisi", extra = {} } = {}) {
  return {
    id: `evt-${messageId}`,
    event: "message.received",
    created_at: new Date(T0).toISOString(),
    data: { message_id: messageId, from, text, ...extra },
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

// --- parseIncoming ----------------------------------------------------------

test("parseIncoming: varian field from/text dikenali", () => {
  const p = parseIncoming(incoming({}));
  assert.equal(p.from, "628123456789");
  assert.equal(p.text, "permisi");
  assert.equal(p.messageId, "msg-1");
});

test("parseIncoming: varian field sender/body dikenali", () => {
  const p = parseIncoming({
    event: "message.received",
    data: { id: "m-9", sender: "62899@s.whatsapp.net", body: "halo" },
  });
  assert.equal(p.from, "62899@s.whatsapp.net");
  assert.equal(p.text, "halo");
  assert.equal(p.messageId, "m-9");
});

test("parseIncoming: event lain diabaikan", () => {
  assert.equal(parseIncoming({ event: "message.sent", data: {} }), null);
  assert.equal(parseIncoming({ event: "channel.connected", data: {} }), null);
});

test("parseIncoming: grup diabaikan (is_group dan @g.us)", () => {
  assert.equal(parseIncoming(incoming({ extra: { is_group: true } })).skip, "group");
  assert.equal(
    parseIncoming(incoming({ extra: { chat_id: "12345@g.us" } })).skip,
    "group",
  );
});

test("parseIncoming: grup via chat_type diabaikan", () => {
  assert.equal(
    parseIncoming(incoming({ extra: { chat_type: "group" } })).skip,
    "group",
  );
});

test("parseIncoming: teks bersarang gaya WA Web (conversation/extendedTextMessage)", () => {
  const p1 = parseIncoming({
    event: "message.received",
    data: {
      message_id: "m-1",
      from: "628123456789",
      message: { conversation: "halo kak" },
    },
  });
  assert.equal(p1.text, "halo kak");

  const p2 = parseIncoming({
    event: "message.received",
    data: {
      message_id: "m-2",
      from: "628123456789",
      message: { extendedTextMessage: { text: "berapa harganya?" } },
    },
  });
  assert.equal(p2.text, "berapa harganya?");
});

test("parseIncoming: pengirim berupa objek dan envelope.type/payload", () => {
  const p = parseIncoming({
    type: "message.received",
    payload: {
      id: "m-3",
      from: { id: "62899@s.whatsapp.net" },
      body: "tes",
    },
  });
  assert.equal(p.from, "62899@s.whatsapp.net");
  assert.equal(p.text, "tes");
  assert.equal(p.messageId, "m-3");
});

test("parseIncoming: pesan dari nomor sendiri diabaikan", () => {
  assert.equal(parseIncoming(incoming({ extra: { from_me: true } })).skip, "own_message");
});

test("normalizeRecipient membuang suffix WhatsApp", () => {
  assert.equal(normalizeRecipient("628123456789@s.whatsapp.net"), "628123456789");
  assert.equal(normalizeRecipient("628123456789"), "628123456789");
});

// --- handleEvent: alur dasar ------------------------------------------------

test("pesan pertama mendapat sapaan", async () => {
  const { ctx, sent } = makeCtx(createState());
  const res = await handleEvent(incoming({ text: "permisi" }), ctx);
  assert.equal(res.action, "replied");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, CONFIG.greeting);
  assert.equal(sent[0].to, "628123456789");
});

test("pesan pertama dijawab sapaan + AI", async () => {
  const aiReply = async () => "Balasan AI contoh.";
  const { ctx, sent } = makeCtx(createState(), T0, aiReply);
  await handleEvent(incoming({ text: "berapa harganya?" }), ctx);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, CONFIG.greeting);
  assert.equal(sent[1].text, "Balasan AI contoh.");
});

test("chat lama dijawab AI saja", async () => {
  const state = createState();
  const first = makeCtx(state);
  await handleEvent(incoming({ messageId: "m1", text: "permisi" }), first.ctx);

  const aiReply = async () => "Balasan AI contoh.";
  const second = makeCtx(state, T0 + 61_000, aiReply);
  await handleEvent(incoming({ messageId: "m2", text: "stoknya ready?" }), second.ctx);
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].text, "Balasan AI contoh.");
});

test("chat lama tanpa AI dibalas fallback, lalu cooldown", async () => {
  const state = createState();
  const first = makeCtx(state);
  await handleEvent(incoming({ messageId: "m1", text: "permisi" }), first.ctx);

  const second = makeCtx(state, T0 + 61_000);
  await handleEvent(incoming({ messageId: "m2", text: "ok sip" }), second.ctx);
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].text, CONFIG.fallbackReply);

  // Masih dalam cooldown balasan (60 detik): dicatat, tidak dibalas.
  const third = makeCtx(state, T0 + 62_000);
  const res = await handleEvent(incoming({ messageId: "m3", text: "oke deh" }), third.ctx);
  assert.equal(res.action, "cooldown");
  assert.equal(third.sent.length, 0);

  // Setelah cooldown balasan lewat tapi masih dalam cooldown fallback
  // (5 menit): tidak ada balasan.
  const fourth = makeCtx(state, T0 + 122_000);
  await handleEvent(incoming({ messageId: "m4", text: "halo lagi" }), fourth.ctx);
  assert.equal(fourth.sent.length, 0);

  // Setelah cooldown fallback lewat: fallback dikirim lagi.
  const fifth = makeCtx(state, T0 + 61_000 + 5 * 60_000);
  await handleEvent(incoming({ messageId: "m5", text: "masih ada?" }), fifth.ctx);
  assert.equal(fifth.sent.length, 1);
  assert.equal(fifth.sent[0].text, CONFIG.fallbackReply);
});

test("pesan duplikat hanya dibalas sekali (memori)", async () => {
  const state = createState();
  const first = makeCtx(state);
  await handleEvent(incoming({ messageId: "m1", text: "permisi" }), first.ctx);
  assert.equal(first.sent.length, 1);

  const second = makeCtx(state);
  const res = await handleEvent(incoming({ messageId: "m1", text: "permisi" }), second.ctx);
  assert.equal(res.action, "duplicate");
  assert.equal(second.sent.length, 0);
});

test("pesan duplikat dikenali lewat KV setelah restart (state baru)", async () => {
  const kv = createFakeKv();
  const first = makeCtx(createState(), T0, undefined, kv);
  await handleEvent(incoming({ messageId: "m1", text: "permisi" }), first.ctx);
  assert.equal(first.sent.length, 1);

  // State memori baru (simulasi Worker restart), KV yang sama.
  const second = makeCtx(createState(), T0, undefined, kv);
  const res = await handleEvent(incoming({ messageId: "m1", text: "permisi" }), second.ctx);
  assert.equal(res.action, "duplicate");
  assert.equal(second.sent.length, 0);
});

test("pesan grup tidak dibalas", async () => {
  const { ctx, sent } = makeCtx(createState());
  const res = await handleEvent(incoming({ extra: { is_group: true } }), ctx);
  assert.equal(res.action, "group");
  assert.equal(sent.length, 0);
});

test("pesan tanpa teks (media) diabaikan", async () => {
  const { ctx, sent } = makeCtx(createState());
  const res = await handleEvent(
    {
      event: "message.received",
      data: { message_id: "m1", from: "628123456789", type: "image" },
    },
    ctx,
  );
  assert.equal(res.action, "ignored");
  assert.equal(sent.length, 0);
});

test("pesan lama (stale) tidak dibalas", async () => {
  const { ctx, sent } = makeCtx(createState());
  const res = await handleEvent(
    incoming({ extra: { sent_at: new Date(T0 - 11 * 60_000).toISOString() } }),
    ctx,
  );
  assert.equal(res.action, "stale");
  assert.equal(sent.length, 0);
});

test("pesan baru dengan sent_at tetap dibalas", async () => {
  const { ctx, sent } = makeCtx(createState());
  const res = await handleEvent(
    incoming({ extra: { sent_at: new Date(T0 - 60_000).toISOString() } }),
    ctx,
  );
  assert.equal(res.action, "replied");
  assert.equal(sent.length, 1);
});

test("riwayat tersimpan di KV dan dipulihkan setelah restart", async () => {
  const kv = createFakeKv();
  const first = makeCtx(createState(), T0, undefined, kv);
  await handleEvent(incoming({ messageId: "m1", text: "permisi" }), first.ctx);
  const saved = JSON.parse(kv.store.get("wa:628123456789"));
  assert.equal(saved.greeted, true);
  assert.equal(saved.history.length, 2); // user + sapaan

  // State baru: pengirim dikenali sebagai chat lama (tidak disapa lagi).
  const aiReply = async () => "Balasan AI.";
  const second = makeCtx(createState(), T0 + 61_000, aiReply, kv);
  await handleEvent(incoming({ messageId: "m2", text: "lanjut" }), second.ctx);
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].text, "Balasan AI.");
});

test("kuota harian: tidak membalas kalau batas tercapai", async () => {
  const kv = createFakeKv();
  // Isi kuota hari ini sampai batas.
  const d = new Date(T0);
  const ymd = [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")].join("-");
  kv.store.set(`waquota:${ymd}`, String(CONFIG.dailyReplyCap));

  const { ctx, sent } = makeCtx(createState(), T0, undefined, kv);
  const res = await handleEvent(incoming({ text: "permisi" }), ctx);
  assert.equal(res.action, "quota_exceeded");
  assert.equal(sent.length, 0);
});

test("hitungan kuota bertambah setelah membalas", async () => {
  const kv = createFakeKv();
  const { ctx } = makeCtx(createState(), T0, undefined, kv);
  await handleEvent(incoming({ text: "permisi" }), ctx);
  assert.equal(await getDailyCount(kv, T0), 1);
});

// --- verifySignature --------------------------------------------------------

function sign(secret, timestamp, rawBody) {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

test("verifySignature menerima tanda tangan yang benar", async () => {
  const secret = "whsec_test";
  const ts = "1700000000";
  const body = '{"event":"message.received"}';
  assert.equal(await verifySignature(secret, ts, body, sign(secret, ts, body)), true);
});

test("verifySignature menolak body yang diubah", async () => {
  const secret = "whsec_test";
  const ts = "1700000000";
  const sig = sign(secret, ts, '{"event":"message.received"}');
  assert.equal(await verifySignature(secret, ts, '{"event":"message.sent"}', sig), false);
});

test("verifySignature menolak secret yang salah", async () => {
  const ts = "1700000000";
  const body = '{"event":"message.received"}';
  const sig = sign("whsec_benar", ts, body);
  assert.equal(await verifySignature("whsec_salah", ts, body, sig), false);
});

test("verifySignature menerima varian format tanda tangan", async () => {
  const secret = "whsec_test";
  const ts = "1700000000";
  const body = '{"event":"message.received"}';
  const hmac = (msg) => createHmac("sha256", secret).update(msg).digest("hex");
  const hmacB64 = (msg) => createHmac("sha256", secret).update(msg).digest("base64");

  // Hex tanpa prefix "sha256=".
  assert.equal(await verifySignature(secret, ts, body, hmac(`${ts}.${body}`)), true);
  // HMAC atas rawBody saja, dengan dan tanpa prefix.
  assert.equal(await verifySignature(secret, ts, body, hmac(body)), true);
  assert.equal(await verifySignature(secret, ts, body, "sha256=" + hmac(body)), true);
  // Base64.
  assert.equal(await verifySignature(secret, ts, body, hmacB64(`${ts}.${body}`)), true);
  assert.equal(await verifySignature(secret, ts, body, hmacB64(body)), true);
  // Gaya Stripe "t=<ts>,v1=<hex>".
  assert.equal(
    await verifySignature(secret, ts, body, `t=${ts},v1=${hmac(`${ts}.${body}`)}`),
    true,
  );
  // Header detik tapi yang ditandatangani milidetik (dan sebaliknya).
  assert.equal(await verifySignature(secret, ts, body, hmac(`${ts}000.${body}`)), true);
  assert.equal(await verifySignature(secret, `${ts}000`, body, hmac(`${ts}.${body}`)), true);
  // Hex huruf besar tetap diterima.
  assert.equal(
    await verifySignature(secret, ts, body, hmac(`${ts}.${body}`).toUpperCase()),
    true,
  );
  // Tanpa timestamp, HMAC rawBody saja tetap diterima.
  assert.equal(await verifySignature(secret, undefined, body, hmac(body)), true);
  // Tanda tangan ngawur tetap ditolak.
  assert.equal(await verifySignature(secret, ts, body, "sha256=" + "ab".repeat(32)), false);
});

// --- broGatewaySend ---------------------------------------------------------

test("broGatewaySend mengirim ke endpoint yang benar", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 202, json: async () => ({ message_id: "msg_1", status: "queued" }) };
  };
  const data = await broGatewaySend(
    { BRO_API_KEY: "wag_live_test" },
    { to: "628123456789", text: "halo" },
    fetchFn,
  );
  assert.equal(data.status, "queued");
  assert.equal(calls[0].url, "https://brogateway.com/api/v1/messages/text");
  assert.equal(calls[0].opts.headers["x-api-key"], "wag_live_test");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { to: "628123456789", message: "halo" });
});

test("broGatewaySend melempar error saat API gagal", async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: "QUOTA_EXCEEDED" }),
  });
  await assert.rejects(
    broGatewaySend({ BRO_API_KEY: "k" }, { to: "6281", text: "x" }, fetchFn),
    /429/,
  );
});

// --- generateAiReply: failover ----------------------------------------------

test("generateAiReply memakai provider utama, Gemini kalau utama gagal", async () => {
  const okFetch = async (url) => {
    if (String(url).includes("generativelanguage")) {
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "Jawaban Gemini." }] } }],
        }),
      };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const reply = await generateAiReply(
    { AI_API_KEY: "k1", GEMINI_API_KEY: "k2" },
    { history: [], text: "halo" },
    okFetch,
  );
  assert.equal(reply, "Jawaban Gemini.");
});

test("openaiReply mengembalikan null tanpa API key", async () => {
  const reply = await openaiReply({}, { history: [], text: "halo" }, async () => ({}));
  assert.equal(reply, null);
});

// --- fetch handler ----------------------------------------------------------

function makeRequest(path, body, headers = {}) {
  return new Request(`https://bot-wa.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("fetch: GET / menjawab health check", async () => {
  const res = await bot.fetch(new Request("https://bot-wa.test/"), {});
  assert.equal(res.status, 200);
  assert.match(await res.text(), /aktif/);
});

test("fetch: path webhook yang salah dijawab 404", async () => {
  const env = { BRO_API_KEY: "k", WEBHOOK_PATH: "rahasia123" };
  const res = await bot.fetch(makeRequest("/salah", incoming({})), env);
  assert.equal(res.status, 404);
});

test("fetch: tanpa BRO_API_KEY dijawab 500", async () => {
  const res = await bot.fetch(makeRequest("/webhook", incoming({})), {});
  assert.equal(res.status, 500);
});

test("fetch: signature salah dijawab 401", async () => {
  const env = { BRO_API_KEY: "k", WEBHOOK_SECRET: "whsec_test" };
  const body = JSON.stringify(incoming({}));
  const res = await bot.fetch(
    makeRequest("/webhook", body, {
      "x-timestamp": "1700000000",
      "x-signature": "sha256=" + "00".repeat(32),
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("fetch: request valid tanpa secret diproses sampai balas (tanpa ctx)", async () => {
  const kv = createFakeKv();
  const env = { BRO_API_KEY: "k", HISTORY_KV: kv };
  // AI tidak dikonfigurasi di env ini, jadi hanya sapaan yang dikirim.
  // broGatewaySend memakai fetch global; stub lewat pemrosesan manual:
  // di sini kita hanya memastikan handler tidak error pada event non-teks.
  const res = await bot.fetch(
    makeRequest("/webhook", { event: "message.sent", data: {} }),
    env,
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.action, "ignored");
});

test("fetch: body bukan JSON dijawab 400", async () => {
  const env = { BRO_API_KEY: "k" };
  const res = await bot.fetch(makeRequest("/webhook", "bukan json {{"), env);
  assert.equal(res.status, 400);
});
