# Bot WhatsApp — Bro Gateway

Balasan otomatis AI untuk WhatsApp Business lewat [Bro Gateway](https://brogateway.com)
(gateway WhatsApp Web berbasis REST API, tanpa Meta Business API dan tanpa
verifikasi bisnis). Pengganti proyek bot WA Cloud API yang batal karena
portofolio bisnis Meta dikunci permanen.

## Cara kerja

1. Pelanggan chat ke nomor WA Business.
2. Bro Gateway mengirim event `message.received` ke webhook Worker ini.
3. Worker membalas otomatis dengan AI (DeepSeek dulu, Gemini sebagai
   cadangan), dengan riwayat percakapan per pengirim.
4. Balasan dikirim balik lewat API Bro Gateway.

## File

- `wa-brogateway-bot.mjs` — kode Worker (tempel ke Cloudflare Worker).
- `wa-brogateway-bot.test.mjs` — tes (32 tes, jalankan
  `node --test wa-brogateway-bot.test.mjs`).

## Setup

1. Daftar di Bro Gateway (paket Free: 200 pesan/hari), tautkan nomor WA
   Business lewat scan QR, buat token API di dashboard.
2. Buat Worker baru di Cloudflare (mis. `bot-wa`), tempel
   `wa-brogateway-bot.mjs`, deploy.
3. Atur secret di Worker Settings > Variables:
   - `BRO_API_KEY` — token API Bro Gateway (`wag_live_...`).
   - `WEBHOOK_PATH` — nilai acak untuk path webhook (32 hex).
   - `WEBHOOK_SECRET` — opsional, kalau dashboard Bro Gateway menampilkan
     secret saat menyimpan webhook.
   - `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` — DeepSeek (sama seperti bot
     Telegram).
   - `GEMINI_API_KEY` — cadangan.
4. Binding KV `HISTORY_KV` ke namespace yang sama dengan bot Telegram
   (`telegram-bot-history`) — key memakai prefix `wa:` jadi tidak bentrok.
5. Di dashboard Bro Gateway, atur webhook URL ke
   `https://bot-wa.<subdomain>.workers.dev/<WEBHOOK_PATH>`, aktifkan event
   `message.received`.
6. Tes: kirim pesan WA ke nomor bisnis dari HP lain, bot harus membalas
   sapaan + jawaban AI.

## Perilaku

- Pengirim baru: sapaan + jawaban AI. Chat lama: jawaban AI saja.
- Grup, media, dan pesan tanpa teks diabaikan.
- Tiap pengirim dibalas maksimal sekali per menit; pesan lama (>10 menit)
  tidak dibalas.
- Dedup lewat KV supaya kiriman ulang webhook tidak dibalas dua kali.
- Batas 190 balasan/hari (paket Free: 200 pesan/hari).
- Persona: CS Rindou Store yang ramah; tidak pernah mengarang harga/stok.

## Mematikan bot

- Putuskan perangkat tertaut di aplikasi WA Business (Perangkat Tertaut >
  sesi Bro Gateway > Keluar) — akses gateway langsung mati.
- Cabut token API di dashboard Bro Gateway.
- Hapus webhook URL di dashboard Bro Gateway.
