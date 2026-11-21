# Panduan Setup Bot Auto-Reply WhatsApp (Cloud API + Cloudflare Worker)

Bot ini membalas pesan WhatsApp yang masuk ke nomor bisnismu secara otomatis
pakai AI, lengkap dengan panel inbox sendiri untuk melihat percakapan dan
membalas manual. Tidak butuh VPS dan tidak ada langganan: Cloudflare Worker
punya paket gratis, dan Meta memberi 1.000 balasan gratis per nomor per bulan.
Proyek ini memakai jalur API-only + panel sendiri, tanpa aplikasi WhatsApp
Business.

> ⚠️ **PENTING — pilih jalur yang benar sebelum mulai**
>
> Ada dua cara menghubungkan nomor ke Cloud API:
>
> 1. **Coexistence (disarankan untuk nomor yang sudah dipakai)** — nomor
>    TETAP bisa dipakai di aplikasi WhatsApp Business seperti biasa, dan
>    bot jalan lewat API di nomor yang sama. Pesan masuk sampai ke
>    aplikasi dan ke bot sekaligus; kamu tetap bisa balas manual dari
>    HP, bot membalas otomatis. Riwayat chat di HP tetap utuh (sampai
>    6 bulan terakhir ikut tersinkron). Pilih jalur ini saat Embedded
>    Signup menawarkan opsi "tetap pakai aplikasi" / coexistence.
> 2. **Migrasi penuh** — nomor pindah sepenuhnya ke Cloud API dan
>    aplikasi WhatsApp Business berhenti bekerja untuk nomor itu
>    (logout). Riwayat chat, grup, broadcast list, label, dan katalog
>    di aplikasi hilang (backup dulu kalau perlu; backup tidak bisa
>    diimpor ke API). Pilih ini hanya kalau nomor memang khusus bot.
>
> **Nomor baru yang belum pernah didaftarkan ke WhatsApp mana pun**
> adalah jalur paling bersih: nomor langsung didaftarkan ke Cloud API
> tanpa migrasi dan tanpa kehilangan apa pun. Satu-satunya syarat,
> nomor itu harus bisa menerima kode OTP lewat SMS atau telepon saat
> verifikasi. Catatannya, nomor baru menjadi jalur khusus bot
> (API-only): tidak ada aplikasi WhatsApp di nomor itu, jadi balas
> manual hanya bisa lewat dashboard/inbox, bukan dari HP.
>
> Coexistence ketersediaannya bisa berbeda tergantung wilayah dan nomor;
> kalau saat signup opsinya tidak muncul, berarti nomor itu belum
> mendukungnya. Migrasi bersifat bisa dibalik: nomor bisa kembali ke
> aplikasi setelah dihapus (deregister) dari Cloud API.
>
> Catatan soal balasan ganda: di mode coexistence, bot membalas otomatis
> dan kamu juga bisa membalas dari aplikasi — pelanggan bisa menerima
> dua balasan. Pola yang umum: bot menjawab duluan secara instan, lalu
> kamu menindaklanjuti dari aplikasi kalau perlu. Kalau mau, bot bisa
> dibatasi (misal hanya membalas di luar jam kerja, atau hanya untuk
> kata kunci tertentu) — itu pengembangan lanjutan.

## Yang kamu butuhkan

- Akun Meta for Developers (pakai akun Facebook biasa bisa).
- Nomor WhatsApp Bisnis yang mau dijadikan bot (bisa nomor yang sekarang
  ada di aplikasi WhatsApp Business).
- Akun Cloudflare (yang sama dengan yang dipakai untuk Worker Orbit Chat).
- API key provider AI yang sama seperti di Orbit Chat (misal ai.ipeenk.com
  atau kunciai.id), lengkap dengan base URL dan nama modelnya.

## Langkah 1 — Buat aplikasi di Meta for Developers

1. Buka https://developers.facebook.com/ dan masuk.
2. **My Apps → Create App**.
3. Pilih tipe yang ada produk WhatsApp-nya (biasanya **Business** atau
   use case WhatsApp), beri nama, misal `Bot WA`.
4. Di dashboard aplikasi, cari produk **WhatsApp** lalu klik **Set up**.

## Langkah 2 — Daftarkan nomor bisnis

1. Di menu aplikasi, buka **WhatsApp → API Setup**.
2. Klik **Add phone number** (atau lewat Embedded Signup).
3. Ikuti alurnya: pilih/buat WhatsApp Business Account, lalu masukkan
   nomor bisnismu. **Saat ditawari pilihan, pilih Coexistence
   ("tetap pakai aplikasi")** supaya nomor tetap bisa dipakai di
   aplikasi WhatsApp Business. Jangan pilih migrasi penuh kecuali
   memang mau nomor khusus bot.
4. Verifikasi nomor dengan kode OTP yang dikirim Meta (SMS/telepon).
5. Setelah berhasil, catat dua hal ini dari halaman API Setup:
   - **Phone Number ID** (angka panjang, ini BUKAN nomor teleponnya)
   - **WhatsApp Business Account ID (WABA ID)**

## Langkah 3 — Ambil App Secret

1. Di menu aplikasi, buka **Settings → Basic**.
2. Di bagian **App Secret**, klik **Show** dan salin nilainya.
3. Simpan baik-baik, ini dipakai Worker untuk memverifikasi bahwa
   webhook benar-benar datang dari Meta.

## Langkah 4 — Buat token permanen (System User)

Token yang muncul di halaman API Setup hanya berlaku 24 jam. Untuk bot
yang jalan terus, buat token permanen:

1. Buka **Meta Business Settings** → **Users → System Users** → **Add**.
   (Bisa juga dari App → WhatsApp → API Setup, cari opsi generate
   permanent token.)
2. Beri nama, misal `wa-bot`, dengan peran **Admin**.
3. Pilih System User itu → **Add Assets** → pilih aplikasi WhatsApp-mu →
   beri akses **Manage app** (atau sesuai yang tersedia).
4. **Generate New Token** → pilih aplikasi → centang izin
   `whatsapp_business_messaging` (dan `whatsapp_business_management`
   kalau ada) → **Generate Token**.
5. Salin tokennya. Token ini tidak kedaluwarsa (selama tidak dicabut),
   dan ini yang dipakai sebagai `WHATSAPP_TOKEN`.

## Langkah 5 — Deploy Worker ke Cloudflare

1. Buka https://dash.cloudflare.com/ → **Workers & Pages** → **Create** →
   **Create Worker** (atau **Create Application**).
2. Beri nama, misal `wa-bot`, lalu **Deploy**.
3. Klik **Edit code** (atau **Configure Worker**), hapus semua kode
   contoh, lalu tempel seluruh isi file `wa-bot-worker.mjs`.
4. **Save and Deploy**. Catat URL Worker-mu, bentuknya:
   `https://wa-bot.<subdomain-kamu>.workers.dev`

## Langkah 6 — Isi secrets di Worker

Di dashboard Cloudflare, buka Worker `wa-bot` → **Settings →
Variables and Secrets** → tambahkan ini (pakai **Secret** untuk yang
sensitif):

| Nama | Isi | Jenis |
| --- | --- | --- |
| `VERIFY_TOKEN` | String acak buatanmu, misal `wa-bot-rahasiaku-2026` | Secret |
| `WHATSAPP_TOKEN` | Token permanen dari Langkah 4 | Secret |
| `PHONE_NUMBER_ID` | Phone Number ID dari Langkah 2 | Text |
| `APP_SECRET` | App Secret dari Langkah 3 | Secret |
| `AI_API_KEY` | API key provider AI-mu | Secret |
| `AI_BASE_URL` | Base URL provider AI, misal `https://ai.ipeenk.com/v1` | Text |
| `AI_MODEL` | Nama model, misal `gpt-4o-mini` | Text |
| `PANEL_PASSWORD` | Password login panel (username: `admin`) | Secret |
| `SYSTEM_PROMPT` | (Opsional) Kepribadian bot | Text |
| `BOT_NAME` | (Opsional) Nama bot | Text |

Setelah semua terisi, klik **Deploy** lagi supaya Worker memakai
nilai terbaru.

### Pasang KV untuk panel inbox

Panel menyimpan pesan di KV Cloudflare. Tanpa ini bot tetap membalas,
tapi pesan tidak disimpan dan panel kosong.

1. Di dashboard Cloudflare, buka **Workers & Pages → KV** → **Create
   namespace**, beri nama misal `wa-bot-inbox`.
2. Buka Worker `wa-bot` → **Settings → Bindings** → **Add binding** →
   pilih **KV Namespace** → **Variable name**: `INBOX_KV` → pilih
   namespace `wa-bot-inbox` → **Deploy**.

> Jangan pernah menempel token atau API key di chat, di kode, atau di
> GitHub. Semua kredensial hanya lewat Secrets di dashboard Cloudflare.

## Langkah 7 — Sambungkan webhook di Meta

1. Kembali ke aplikasi Meta → **WhatsApp → Configuration**.
2. Di bagian **Webhook**, klik **Edit**:
   - **Callback URL**: `https://wa-bot.<subdomain-kamu>.workers.dev/webhook`
   - **Verify Token**: isi persis sama dengan `VERIFY_TOKEN` di Worker.
3. Klik **Verify and save**. Kalau gagal, cek lagi URL-nya (harus
   lengkap sampai `/webhook`) dan pastikan `VERIFY_TOKEN` sama persis
   di kedua tempat.
4. Di bawahnya, klik **Manage** pada Webhook fields, centang
   **messages**, lalu **Done**.

## Langkah 8 — Tes

1. Dari HP lain (bukan nomor bot), kirim pesan WhatsApp ke nomor bot,
   misal: `halo`.
2. Bot seharusnya membalas dalam beberapa detik.
3. Kalau tidak ada balasan, buka dashboard Cloudflare → Worker `wa-bot`
   → **Logs** → **Begin log stream**, kirim pesan lagi, dan lihat
   pesan error-nya.

## Memakai panel inbox

1. Buka `https://wa-bot.<subdomain-kamu>.workers.dev/panel`.
2. Login: username `admin`, password = `PANEL_PASSWORD` yang kamu isi
   di secrets.
3. Daftar percakapan di kiri, isi chat di kanan. Panel me-refresh
   otomatis tiap 5 detik.
4. Untuk membalas manual, ketik di kolom bawah lalu kirim.
5. Tombol **Jeda bot** di tiap percakapan: bot berhenti membalas nomor
   itu (pesan tetap tersimpan dan terlihat di panel), supaya kamu yang
   pegang percakapannya. Klik lagi untuk mengaktifkan bot kembali.

## Batas dan biaya

- **1.000 balasan pertama per nomor per bulan gratis.** Selebihnya
  $0,025 per balasan ke nomor Indonesia (tarif Meta Oktober 2026,
  bisa berubah tiap kuartal).
- **Limit awal:** sebelum verifikasi bisnis, nomor dibatasi 250
  pengguna unik per 24 jam. Untuk menaikkannya, selesaikan
  verifikasi bisnis di Meta Business Settings (butuh dokumen usaha,
  proses 1–5 hari kerja).
- **Jendela 24 jam:** bot hanya membalas orang yang chat duluan, jadi
  balasan selalu masuk jendela layanan 24 jam dan tidak butuh template.
- **Cloudflare Worker:** paket gratis mencakup 100.000 request per
  hari, jauh di atas kebutuhan bot ini.
- **Biaya AI:** mengikuti pemakaian API key-mu sendiri, sama seperti
  di Orbit Chat.

## Kalau ada masalah

| Gejala | Kemungkinan penyebab |
| --- | --- |
| Webhook gagal diverifikasi | URL salah / kurang `/webhook`, `VERIFY_TOKEN` tidak sama, Worker belum di-deploy ulang setelah isi secrets |
| Bot tidak membalas sama sekali | Webhook field `messages` belum dicentang; `WHATSAPP_TOKEN` kedaluwarsa (pakai token System User, bukan token 24 jam); cek Logs Worker |
| Bot membalas "saya sedang bermasalah" | AI error: cek `AI_API_KEY`, `AI_BASE_URL` (harus HTTPS dan berakhiran `/v1`), `AI_MODEL`, dan kuota provider |
| Balasan ganda | Meta mengirim ulang webhook kalau Worker lambat merespons; Worker sudah punya dedup best-effort, tapi duplikat sesekali masih mungkin |
| Error 131047 di log | Pesan gagal terkirim, biasanya nomor tujuan tidak valid atau di luar jendela 24 jam |

## Pengembangan selanjutnya (kalau mau)

- Ingatan percakapan per pengirim (pakai KV atau Durable Object) supaya
  bot nyambung dengan chat sebelumnya.
- Membalas gambar/suara (baca media lewat Cloud API, kirim ke AI
  yang mendukung vision/audio).
- Perintah khusus, misal `!menu`, `!harga`, `!manusia` untuk
  meneruskan ke admin.
- Pencarian percakapan dan ekspor riwayat chat dari panel.
- Notifikasi (misal ke Telegram atau email) saat ada pesan baru yang
  belum dibalas.
