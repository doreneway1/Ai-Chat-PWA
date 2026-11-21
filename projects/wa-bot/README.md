# Bot Auto-Reply WhatsApp (Cloud API + Cloudflare Worker)

Bot WhatsApp yang membalas pesan masuk secara otomatis memakai AI.
Berjalan di Cloudflare Worker (serverless, tanpa VPS), memakai
WhatsApp Cloud API resmi dari Meta dan API AI yang kompatibel OpenAI.

## Cara kerja

```
Pelanggan --WA--> Meta Cloud API --webhook--> Cloudflare Worker
   Cloudflare Worker --chat completions--> Provider AI
   Cloudflare Worker --kirim balasan--> Meta Cloud API --WA--> Pelanggan
```

## File

| File | Isi |
| --- | --- |
| `wa-bot-worker.mjs` | Kode Worker (satu file, siap tempel di dashboard Cloudflare) |
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

## Biaya

- Meta: 1.000 service message pertama per nomor per bulan gratis,
  selebihnya $0,025 per balasan ke nomor Indonesia (tarif Okt 2026).
- Cloudflare Worker: paket gratis 100.000 request/hari.
- AI: mengikuti pemakaian API key sendiri.

## Setup singkat

Lihat `PANDUAN_SETUP.md`. Ringkasnya: buat aplikasi di Meta for
Developers → daftarkan nomor (Coexistence kalau nomor sudah dipakai di
aplikasi WA Business, langsung daftar kalau nomor baru) → buat token
permanen (System User) → deploy Worker → isi secrets → sambungkan
webhook → tes dengan mengirim WA ke nomor bot.

## Secrets Worker

`VERIFY_TOKEN`, `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `APP_SECRET`,
`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, dan opsional `SYSTEM_PROMPT`,
`BOT_NAME`. Semua kredensial hanya lewat Secrets di dashboard
Cloudflare — jangan pernah dimasukkan ke kode atau repo.
