// wa-debug.mjs — Worker DEBUG sementara (bukan bot).
//
// Merekam setiap webhook yang masuk (header + body mentah) ke KV supaya
// kita bisa melihat format signature dan bentuk payload ASLI dari
// Bro Gateway, lalu membalas 200. Dipakai hanya selama diagnosis;
// setelah selesai, Worker bot yang asli di-deploy ulang dan kunci
// debug di KV dihapus.
//
// Yang direkam: header request, path, dan body mentah (maks 8000 karakter)
// per kiriman, di key `dbg:<timestamp>:<acak>` (TTL 1 jam).
// Tidak memverifikasi signature dan tidak membalas apa pun.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Bot WA (mode debug) aktif.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Path webhook rahasia tetap dijaga (secret WEBHOOK_PATH tidak berubah).
    if (env.WEBHOOK_PATH && url.pathname !== `/${env.WEBHOOK_PATH}`) {
      return new Response("Not found", { status: 404 });
    }

    const rawBody = await request.text();
    const headers = {};
    request.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const record = {
      at: new Date().toISOString(),
      method: request.method,
      path: url.pathname,
      headers,
      bodyLength: rawBody.length,
      body: rawBody.slice(0, 8000),
    };
    if (env.HISTORY_KV) {
      const key = `dbg:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      try {
        await env.HISTORY_KV.put(key, JSON.stringify(record), {
          expirationTtl: 3600,
        });
      } catch (err) {
        console.error("KV debug put error:", err);
      }
    }
    return Response.json({ ok: true, debug: true });
  },
};
