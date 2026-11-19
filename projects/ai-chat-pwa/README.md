# Orbit AI Chat PWA

Chat AI berbasis web dengan beberapa koneksi OpenAI-compatible, pemilihan model lokal berdasarkan tingkat tugas, lampiran, dan riwayat yang tersimpan di browser. PWA statis ini memakai Cloudflare Worker sebagai relay HTTPS/CORS; tidak memerlukan VPS.

## Menyiapkan Cloudflare Worker

1. Di Cloudflare Dashboard, buka **Workers & Pages → Create application → Create Worker**, lalu deploy Worker baru.
2. Pada Worker, pilih **Edit code**. Salin seluruh isi [`cloudflare/ai-chat-proxy.mjs`](./cloudflare/ai-chat-proxy.mjs), ganti kode contoh, lalu **Deploy**.
3. Catat alamat Worker, misalnya `https://orbit-ai-proxy.<subdomain>.workers.dev`.
4. Worker hanya menerima origin `https://doreneway1.github.io` dan host upstream HTTPS yang diizinkan. Host bawaan: `ai.ipeenk.com` dan `kunciai.id`.
5. Untuk provider lain, tambahkan variable Worker bernama `ALLOWED_UPSTREAM_HOSTS` dengan daftar hostname dipisahkan koma, tanpa skema atau path, misalnya `api.provider-a.com,api.provider-b.com`. Atur melalui **Worker → Settings → Variables and Secrets**, lalu deploy ulang. Jangan mengganti pembatasan host dengan proxy terbuka.

## Mengatur koneksi dan model

Buka aplikasi lalu pilih **⚙ Pengaturan API**:

- Masukkan URL Cloudflare Worker tanpa path.
- Tambahkan hingga 10 koneksi. Setiap koneksi memakai nama, Base URL HTTPS provider yang berakhiran `/v1`, API key, dan daftar model.
- **Muat model** mengambil daftar dari endpoint `/v1/models` provider. Jika tidak tersedia, isi manual, satu per baris: `ID model | fast,balanced,deep,default`.
- Tekan **Test koneksi** untuk tiap provider. Test menggunakan model pertama di daftar dan dapat memakai sedikit token. Tombol simpan aktif setelah semua koneksi lulus test.

Tingkat **Auto**, **Cepat**, **Seimbang**, dan **Mendalam** memilih model lokal dari tag yang kamu berikan pada daftar model. Auto memakai heuristik sederhana di perangkat—tidak mengirim prompt ke router tambahan. Jika tidak ada tag yang cocok, aplikasi mencoba model `default`, lalu `balanced`, lalu model pertama. Pemilihan ini hanya berjalan di antara model yang kamu konfigurasi; bukan layanan perutean lintas provider.

## Lampiran dan riwayat

- Maksimal 5 file per pesan, masing-masing maksimal 10 MB.
- Teks/kode umum dibaca sebagai teks; PDF dibatasi 80 halaman; DOCX, XLSX, PPTX diekstrak di browser; gambar PNG, JPEG, dan WebP dikirim sebagai gambar. Total gambar per pesan maksimal 5 MB.
- XLSX/PPTX/DOCX diproses di perangkat. Isi yang diekstrak, prompt, dan gambar dikirim ke Worker lalu ke provider saat chat dikirim. Dukungan gambar juga bergantung pada provider/model.
- Riwayat dan lampiran tersimpan di IndexedDB lokal browser, sedangkan pengaturan termasuk API key tersimpan di localStorage tanpa enkripsi. Data tidak disinkronkan antarperangkat; menghapus data situs/browser dapat menghapusnya.
- Gaya respons dibuat lugas untuk permintaan aman. Aplikasi tidak dapat menjamin semua output tanpa batasan atau menonaktifkan kebijakan provider.

## Pengembangan lokal

```bash
cd projects/ai-chat-pwa
npm ci
npm test
npm run build
python3 -m http.server 8000 --directory dist
```

Worker bawaan hanya mengizinkan origin GitHub Pages tersebut. Untuk menguji dari localhost, tambahkan origin lokal yang tepat ke `ALLOWED_ORIGINS` di source Worker dan deploy ulang. Jangan tambahkan wildcard origin.

## Publikasi

Workflow GitHub Actions membangun PWA dengan Vite lalu menerbitkan folder `dist` ke GitHub Pages. Riwayat dan API key tidak dimasukkan ke bundle. Setelah mengubah source Worker, salin dan deploy ulang Worker secara terpisah melalui Cloudflare Dashboard.
