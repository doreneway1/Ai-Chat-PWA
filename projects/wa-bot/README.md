# Bot Auto-Reply WhatsApp (Cloud API + Cloudflare Worker)

Bot WhatsApp yang membalas pesan masuk secara otomatis memakai AI,
lengkap dengan **panel inbox sendiri** untuk melihat percakapan dan
membalas manual. Berjalan di satu Cloudflare Worker (serverless, tanpa
VPS), memakai WhatsApp Cloud API resmi dari Meta dan API AI yang
kompatibel OpenAI. Jalur API-only: tidak memakai aplikasi WhatsApp
Business sama sekali.

## Cara kerja

```
Pelanggan --WA--> Meta Cloud API --webhook--> Cloudflare Worker
   Cloudflare Worker --simpan--> KV (panel inbox)
   Cloudflare Worker --chat completions--> Provider AI
   Cloudflare Worker --kirim balasan--> Meta Cloud API --WA--> Pelanggan

Kamu --browser--> https://<worker>.workers.dev/panel
   (lihat percakapan, balas manual, jeda bot per nomor)
```

## File

| File | Isi |
| --- | --- |
| `wa-bot-worker.mjs` | Kode Worker (bot + panel, satu file, siap tempel di dashboard Cloudflare) |
| `wa-bot-worker.test.mjs` | Tes lokal (17 tes, jalankan dengan `node wa-bot-worker.test.mjs`) |
| `PANDUAN_SETUP.md` | Panduan setup lengkap Bahasa Indonesia |
| `wrangler.toml` | Konfigurasi deploy lewat Wrangler CLI (opsional) |

## Fitur

- Verifikasi webhook Meta (`hub.challenge`) dan signature HMAC-SHA256
  (`X-Hub-Signature-256`) dengan App Secret.
- Respons 200 cepat ke Meta, pekerjaan berat jalan di background
  (`ctx.waitUntil`) supaya webhook tidak dikirim ulang.
- Dedup pesan masuk (best-effort) berdasarkan message ID.
- Tandai pesan dibaca + indikator mengetik.
- Balasan AI lewat API yang kompatibel OpenAI (sama seperti Orbit Chat).
- Hanya membalas pesan teks (v1) supaya hemat jatah pesan.
- **Panel inbox (`/panel`)**: daftar percakapan, riwayat pesan,
  balas manual, dan tombol jeda bot per nomor. Login Basic Auth
  (username `admin`, password `PANEL_PASSWORD`). Pesan disimpan di KV
  (binding `INBOX_KV`, maks 200 pesan per percakapan).

## Biaya

- Meta: 1.000 service message pertama per nomor per bulan gratis,
  selebihnya $0,025 per balasan ke nomor Indonesia (tarif Okt 2026).
- Cloudflare Worker: paket gratis 100.000 request/hari. KV: paket gratis
  100.000 baca/hari dan 1.000 tulis/hari.
- AI: mengikuti pemakaian API key sendiri.

## Setup singkat

Lihat `PANDUAN_SETUP.md`. Ringkasnya: buat aplikasi di Meta for
Developers → daftarkan nomor (migrasi penuh nomor lama, atau nomor baru
langsung ke Cloud API) → buat token permanen (System User) → deploy
Worker → buat namespace KV dan pasang binding `INBOX_KV` → isi secrets
→ sambungkan webhook → tes dengan mengirim WA ke nomor bot → buka panel
di `https://<worker>.workers.dev/panel`.

## Secrets Worker

`VERIFY_TOKEN`, `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `APP_SECRET`,
`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `PANEL_PASSWORD`, dan opsional
`SYSTEM_PROMPT`, `BOT_NAME`. Semua kredensial hanya lewat Secrets di
dashboard Cloudflare — jangan pernah dimasukkan ke kode atau repo.
Binding KV: `INBOX_KV`.
