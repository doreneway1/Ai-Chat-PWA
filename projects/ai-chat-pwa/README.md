# Orbit AI Chat PWA

Client chat statis yang langsung mengirim permintaan dari browser ke **satu** API OpenAI-compatible. Tidak ada 9Router, VPS, proxy, atau backend aplikasi. Proyek ini terpisah dari bot WhatsApp.

## Di mana memasukkan Base URL dan API key

1. Buka aplikasi dan tekan ikon **⚙** di kanan atas atau **Pengaturan API** di sidebar.
2. Isi **Base URL API**, misalnya URL API provider yang berakhiran `/v1`.
3. Isi **Model ID atau alias otomatis** persis seperti yang ditampilkan/didokumentasikan provider. Alias seperti `auto` tidak universal.
4. Tempel **API key** dari layanan yang sama, lalu simpan.

Key tidak diperlukan untuk mengubah atau menjalankan source code dan jangan dikirim ke chat atau commit ke Git. Key disimpan di localStorage browser tanpa enkripsi, jadi gunakan hanya pada perangkat dan origin yang dipercaya.

## Cara kerja auto model

Client mengirim `{ model: "<model-id-atau-alias>", messages: [...] }` ke endpoint itu. Jika daftar provider hanya menampilkan `deepseek-v4-pro`, gunakan ID itu; itu memanggil model tersebut, bukan memilih otomatis di antara banyak model. Alias otomatis hanya merutekan jika provider mendokumentasikan dukungannya, dan tidak bisa memilih model dari API provider lain. Untuk memakai banyak provider tanpa pilihan manual, dibutuhkan satu layanan/router yang memiliki akses ke semuanya.

Layanan provider menentukan model tujuan, biaya, ketersediaan, dan kebijakan konten. Client tidak dapat menjamin semua output “uncensored” atau menonaktifkan kebijakan provider.

## Menjalankan lokal

```bash
cd projects/ai-chat-pwa
python3 -m http.server 8000
```

Buka `http://localhost:8000`. Mengirim chat langsung ke provider memerlukan koneksi internet dan CORS dari provider. Jika provider menolak request browser karena CORS, PWA tidak dapat mengakalinya tanpa proxy/backend; gunakan client desktop yang didukung provider atau endpoint yang mengizinkan CORS.

## Hosting statis tanpa VPS

Workflow GitHub Pages disediakan di `.github/workflows/deploy-ai-chat-pages.yml`. Di GitHub, buka **Settings → Pages**, pilih **GitHub Actions** sebagai sumber deploy, lalu jalankan workflow atau push perubahan ke `main`. Setelah deploy, buka URL Pages dari PC/iPhone dan gunakan **Add to Home Screen** di iPhone. Ini hanya meng-host file statis; tidak ada key yang dimasukkan ke file atau dikirim ke workflow. Setiap browser/perangkat menyimpan key dan riwayatnya sendiri.

## Data lokal

- Riwayat disimpan di IndexedDB pada browser/perangkat yang digunakan dan tidak disinkronkan.
- Base URL, alias, dan key disimpan di localStorage browser tanpa enkripsi.
- Isi chat dikirim ke endpoint yang dikonfigurasi; periksa aturan privasi/retensi provider.
- PWA shell dapat dibuka offline, tetapi chat membutuhkan internet.
