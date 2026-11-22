# Bot Telegram Business — Balasan Otomatis

Bot Cloudflare Worker yang membalas otomatis chat pribadi yang masuk ke akun
Telegrammu, sebagai akunmu sendiri (bukan sebagai bot).

## Cara kerja

- Telegram mengirim update `business_message` ke Worker setiap ada pesan di
  chat pribadi yang diizinkan.
- Worker membalas otomatis: sapaan untuk chat pertama, lalu semua pesan dijawab
  AI supaya jawabannya bervariasi dan nyambung dengan percakapan. Kalau AI
  tidak aktif atau gagal, dipakai balasan standar manual sebagai pengaman.
- Riwayat percakapan disimpan di Cloudflare KV (kalau binding `HISTORY_KV`
  diatur) dengan masa berlaku 24 jam, jadi bot tetap ingat percakapan
  meskipun Worker restart.
- Kalau kamu membalas sendiri di sebuah chat, balasan otomatis dijeda 30 menit
  di chat itu supaya bot tidak menimpa percakapan manusia.
- Batasan Telegram: bot hanya bisa membalas chat yang ada pesan masuk dalam
  24 jam terakhir dan tidak bisa memulai percakapan.

## Persiapan (sekali saja)

1. **Buat bot**: buka @BotFather di Telegram → `/newbot` → ikuti langkahnya
   (nama + username) → salin token botnya.
2. **Aktifkan Secretary Mode** (dulu namanya Business Mode, diganti Telegram
   sejak Mei 2026): di @BotFather → `/mybots` → pilih botmu → Bot Settings →
   Secretary Mode → ON. Di panel baru BotFather: pilih bot → Settings → Mode
   Settings → nyalakan Secretary Mode.
3. **Deploy Worker**: di dashboard Cloudflare (dash.cloudflare.com) →
   Workers & Pages → Create Worker → hapus kode contoh, tempel isi
   `telegram-business-bot.mjs` → Deploy. Catat URL Workernya
   (mis. `https://nama-bot.kamu.workers.dev`).
4. **Atur secret**: di halaman Worker → Settings → Variables → Add Secret:
   `BOT_TOKEN` = token dari BotFather; `WEBHOOK_SECRET` = kata sandi acak
   buatanmu (mis. 16 karakter); `GEMINI_API_KEY` = API key Gemini gratis dari
   Google AI Studio (aistudio.google.com → Get API key).
   Untuk provider AI lain (mis. DeepSeek, termasuk dari reseller), tambahkan:
   `AI_API_KEY` = API key provider; `AI_BASE_URL` = base URL provider
   (default `https://api.deepseek.com`); `AI_MODEL` = nama model
   (default `deepseek-chat`). Tanpa secret AI apa pun, bot hanya memakai
   balasan manual.
5. **Sambungkan KV (opsional, untuk ingatan 24 jam)**: di dashboard
   Cloudflare → Workers & Pages → KV → Create a namespace (beri nama mis.
   `telegram-bot-history`). Lalu di halaman Worker → Settings → Variables →
   KV Namespace Bindings → Add binding → Variable name `HISTORY_KV` →
   pilih namespace yang baru dibuat → Save. Tanpa langkah ini bot tetap
   jalan, tapi riwayat chat hanya di memori dan hilang saat Worker restart.
6. **Pasang webhook**: buka URL ini di browser (ganti TOKEN, URL_WORKER, dan
   RAHASIA dengan nilaimu sendiri):
   `https://api.telegram.org/botTOKEN/setWebhook?url=URL_WORKER&secret_token=RAHASIA&drop_pending_updates=true`
   Kalau berhasil, tampil `{"ok":true,...}`.
7. **Hubungkan bot**: Telegram → Settings → Chat Automation (di versi lama:
   Telegram Business → Chatbots) → pilih botmu → pilih chat yang boleh
   diakses bot.
8. **Uji**: dari akun lain, kirim chat ke akunmu dan lihat balasan otomatisnya.

## Ubah balasan

Edit bagian `CONFIG` di awal `telegram-business-bot.mjs` (sapaan, balasan
standar, dan `systemPrompt` AI), lalu Deploy ulang di Cloudflare.

## Balasan AI

Semua pesan dijawab AI supaya jawabannya bervariasi dan nyambung dengan
percakapan — bot mengingat beberapa pesan terakhir di tiap chat sebagai
konteks. Bot berperan sebagai asisten pribadi yang santai: menjawab secara
umum sesuai topik, tidak mengarahkan ke produk atau toko, dan kalau ditanya
soal pemilik akun, menjelaskan bahwa pemilik sedang sibuk dan akan membalas
kalau sudah ada waktu.

Urutan provider: bot mencoba provider OpenAI-compatible dulu (DeepSeek,
diatur lewat `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL`), lalu Gemini
(`GEMINI_API_KEY`) sebagai cadangan. Tanpa secret AI apa pun, bot hanya
mengirim sapaan dan balasan standar manual.

Sesuaikan `CONFIG.ai.systemPrompt` dengan kebutuhanmu (nama, gaya bicara,
cara menjawab). Riwayat konteks disimpan di KV selama 24 jam (lihat langkah
5 di atas); tanpa KV, riwayat hanya bertahan selama Worker tidak restart.

## Keamanan token

Token bot hanya disimpan sebagai secret di Cloudflare, jangan pernah
dimasukkan ke dalam kode atau dikirim lewat chat.

## Tes lokal

```sh
node --test telegram-business-bot.test.mjs
```
