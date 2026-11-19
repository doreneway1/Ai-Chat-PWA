# Orbit AI Chat PWA

Client chat statis di GitHub Pages dengan relay Cloudflare Worker milikmu. Worker menangani CORS dan meneruskan request Chat Completions ke provider. Tidak perlu VPS, tetapi Worker adalah fungsi serverless yang memproses request.

## Siapkan relay Cloudflare Worker

1. Masuk ke [Cloudflare Dashboard](https://dash.cloudflare.com/) atau buat akun.
2. Buka **Workers & Pages → Create application → Create Worker**. Beri nama, misalnya `orbit-ai-proxy`, lalu deploy Worker contoh.
3. Buka Worker yang baru dibuat dan pilih **Edit code**.
4. Di repo `Ai-Chat-PWA`, buka file `projects/ai-chat-pwa/cloudflare/ai-chat-proxy.mjs`. Salin seluruh isinya, ganti kode contoh di editor Worker dengan kode tersebut, lalu pilih **Deploy**.
5. Catat alamat Worker yang tampil, misalnya `https://orbit-ai-proxy.<subdomain>.workers.dev`.

Worker ini hanya menerima origin `https://doreneway1.github.io` dan host upstream `ai.ipeenk.com` serta `kunciai.id`, memakai HTTPS, Base URL berakhiran `/v1`, dan endpoint Chat Completions. Ia bukan proxy terbuka. Jika berpindah provider, host baru harus ditambahkan ke `ALLOWED_UPSTREAM_HOSTS` pada file Worker lalu Worker di-deploy ulang.

## Hubungkan aplikasi dan uji

Di PWA, buka **⚙ Pengaturan API** dan isi:

- **URL Cloudflare Worker** — URL Worker `workers.dev` tanpa path.
- **Base URL API** — URL provider yang host-nya diizinkan Worker, misalnya `https://kunciai.id/v1`.
- **Model ID atau alias otomatis** — ID persis dari provider, contohnya `kunciai/deepseek-v4.1-flash`.
- **API key** — key provider.

Tekan **Test koneksi**. Tombol **Simpan & hubungkan** aktif hanya jika test berhasil. Test mengirim satu request pendek ke model dan dapat memakai sedikit token. Setelah disimpan, chat diteruskan melalui Worker.

## Privasi dan keamanan

- API key tetap disimpan di localStorage browser tanpa enkripsi. Gunakan hanya perangkat dan origin yang dipercaya.
- Kode Worker tidak menulis API key atau prompt ke log dan tidak menyimpannya secara permanen; tetapi Cloudflare memproses request saat meneruskannya, dan provider juga menerima key/prompt.
- Jangan gunakan URL Worker milik orang lain. Batasi origin dan host sesuai konstanta di source Worker.
- Worker hanya mengizinkan origin GitHub Pages ini. Preview dari Codespaces/localhost tidak diizinkan secara default.
- Request test memakai token provider. Isi pesan chat juga dikirim ke provider; periksa kebijakan retensi layanan tersebut.
- Provider menentukan alias/model yang tersedia, biaya, dan batasan konten. Aplikasi tidak dapat menjamin semua output “uncensored”.

## Menjalankan lokal

```bash
cd projects/ai-chat-pwa
python3 -m http.server 8000
```

Preview lokal tidak dapat memakai Worker yang dikonfigurasi untuk GitHub Pages karena origin-nya berbeda. Untuk mengizinkannya, tambahkan origin lokal yang tepat ke `ALLOWED_ORIGINS` di source Worker, lalu deploy ulang.

## Hosting dan riwayat

Workflow GitHub Actions menerbitkan PWA ke GitHub Pages setelah perubahan di-push ke branch `main`. Riwayat disimpan di IndexedDB pada browser/perangkat masing-masing dan tidak disinkronkan. Pengaturan termasuk API key disimpan terpisah di localStorage setiap origin/perangkat.
