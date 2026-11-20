# dorenewAI PWA

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

## Memilih model saat chat

Dropdown model ada di bar atas chat, di samping titik hijau. **Auto · pilih sesuai tugas** memakai heuristik lokal; pilihan **Provider · model ID** mengunci model tersebut untuk pesan berikutnya. Pilihan tersimpan di browser perangkat ini.

Semua model dari provider yang sudah diuji muncul di dropdown. Tambahkan model melalui **Pengaturan API → Muat model**, lalu test koneksi dan simpan. Ikon lingkaran di area composer membuka tingkat **Auto**, **Cepat**, **Menengah**, atau **Mendalam**. Pilihan ini tetap memengaruhi router lokal untuk pesan berikutnya. Tingkat memilih model berdasarkan tag: `model-id | fast`, `model-id | balanced`, `model-id | deep`, atau `model-id | default`. Model yang diimpor otomatis bertag `balanced`.

Auto memakai heuristik sederhana dan bukan router cerdas atau jaminan kualitas setara Venice. Pemilihan hanya mencakup model yang dikonfigurasi.

Prompt sistem meminta jawaban lugas, menghindari penolakan yang tidak perlu, dan jujur jika tidak punya kemampuan membuka tautan. Prompt tidak menonaktifkan kebijakan provider/model. Aplikasi tidak memiliki browser interaktif; tautan publik dibaca melalui Worker seperti dijelaskan pada bagian Membaca tautan publik, sedangkan isi privat seperti riwayat grup Telegram tetap harus ditempel atau diunggah sebagai ekspor yang memang boleh kamu bagikan.

Ikon pengaturan di sebelah tingkat pemikiran mengatur nama, ikon/foto AI, dan instruksi gaya/konteks. Profil disimpan per room; pengaturan bisa dijadikan default untuk chat baru. Instruksi tidak bisa melewati kebijakan provider/model atau memberi kemampuan yang tidak tersedia. Memori room tetap terpisah. Memori global adalah catatan teks manual yang disimpan di browser perangkat dan hanya dikirim untuk room yang mengaktifkan opsinya; riwayat chat lain tidak otomatis dikirim. Menu ⋯ pada chat menyediakan pin beberapa percakapan, ganti nama, pindah urutan dalam kelompok pin yang sama, dan hapus.

## Membaca tautan publik

Jika pesan berisi tautan `http://` atau `https://`, aplikasi menampilkannya sebagai chip di atas kotak pesan. Saat pesan dikirim, Cloudflare Worker mengambil isi halaman publik tersebut melalui route `POST /api/scrape`, mengekstrak judul, deskripsi, dan teks bersihnya (maksimal 20.000 karakter per tautan, 3 tautan per pesan, total konteks tautan maksimal 40.000 karakter), lalu menyisipkannya sebagai blok `SUMBER WEB` pada pesan tersebut. Hapus chip tautan sebelum mengirim jika isinya tidak ingin dibaca.

- Kemampuan ini milik aplikasi dan Worker, bukan model: semua provider/model yang terhubung dapat memakainya. Model menerima isi halaman sebagai data untuk dianalisis, bukan sebagai instruksi.
- Konteks tautan hanya dikirim ke provider untuk pesan terakhir yang memuatnya, sama seperti lampiran gambar, agar riwayat lama tidak menghabiskan konteks berulang kali. Kartu sumber di bawah pesan menunjukkan tautan yang berhasil atau gagal dibaca; hasil dan kegagalannya tersimpan di riwayat lokal bersama pesan.
- Hanya halaman publik HTML/teks yang dapat dibaca. Halaman yang memerlukan login, dimuat sepenuhnya dengan JavaScript, menolak pengambilan otomatis, atau berada di jaringan privat/lokal akan gagal dan pesan tetap dikirim tanpa isi tautan tersebut. Tautan grup Telegram hanya menghasilkan pratinjau publiknya (nama, deskripsi, jumlah anggota), bukan riwayat percakapan di dalam grup.
- Worker menolak URL berkredensial, port tidak standar, alamat IP privat/reserved, dan pengalihan menuju alamat seperti itu untuk mencegah penyalahgunaan sebagai proxy ke jaringan internal (SSRF). Worker tidak memeriksa hasil DNS, jadi nama domain publik yang diarahkan pemiliknya ke IP privat tidak dapat dideteksi di lapisan ini.
- Isi halaman yang berhasil dibaca dikirim ke provider bersama prompt saat chat dikirim, sama seperti lampiran. Jangan menempelkan tautan yang isinya tidak boleh dibagikan ke provider yang dipilih.
- Fitur ini memakai Worker yang sama dengan relay chat; tidak ada konfigurasi tambahan. Setelah memperbarui source Worker, salin dan deploy ulang Worker secara manual melalui Cloudflare Dashboard agar route `/api/scrape` tersedia.

## Blok kode dan perintah

Jawaban Markdown ditampilkan sebagai paragraf, judul, daftar, tabel, tautan, teks tebal, dan inline code agar tidak terlihat seperti simbol mentah. Jika model mengembalikan fenced code block Markdown, misalnya ` ```yaml `, ` ```json `, ` ```bash `, atau ` ```powershell `, client menampilkannya dengan pewarnaan sintaks serta tombol **Salin** dan **Edit**. Edit mengubah blok tersebut di jawaban dan menyimpan perubahan pada riwayat lokal. Tombol salin hanya menyalin teks; aplikasi tidak menjalankan perintah terminal.

## iPhone dan penyimpanan

Ukuran font kotak chat, editor kode, dan input pengaturan minimal 16 px pada layar ponsel agar Safari tidak memperbesar tampilan otomatis saat kolom disentuh. Identitas avatar diletakkan sejajar dengan nama di atas pesan agar isi pesan memiliki lebar yang konsisten.

## Lampiran dan riwayat

- Maksimal 5 file per pesan, masing-masing maksimal 10 MB.
- Teks/kode umum dibaca sebagai teks; PDF dibatasi 80 halaman; DOCX, XLSX, PPTX diekstrak di browser; gambar PNG, JPEG, dan WebP dikirim sebagai gambar. Total gambar per pesan maksimal 5 MB.
- XLSX/PPTX/DOCX diproses di perangkat. Isi yang diekstrak, prompt, dan gambar dikirim ke Worker lalu ke provider saat chat dikirim. Dukungan gambar juga bergantung pada provider/model.
- API key, Base URL, dan pengaturan provider tersimpan di `localStorage` browser.
- Riwayat chat tersimpan di `IndexedDB` browser. Foto disimpan bersama pesan sebagai data URL/base64; file teks dan dokumen yang dilampirkan disimpan sebagai teks hasil ekstraksi. Artinya foto dan riwayat memang memakai ruang penyimpanan komputer/ponsel ini. Ukurannya bergantung pada panjang chat dan lampiran; data lokal browser juga tunduk pada kuota browser/perangkat.
- Foto profil AI dikompres di browser dan disimpan lokal bersama default atau room terkait.
- Nama internal penyimpanan lama tetap dipertahankan agar pembaruan brand ke dorenewAI tidak menghapus riwayat, key, atau pengaturan yang sudah tersimpan.
- Hapus chat dari daftar percakapan untuk menghapus pesannya beserta lampiran lokalnya. **Clear site data / Hapus data situs** di pengaturan browser menghapus seluruh riwayat serta pengaturan/key situs pada browser itu. Data tidak disinkronkan antarperangkat.
- Penyimpanan browser tidak dienkripsi oleh aplikasi. Lindungi perangkat/profil browser dan jangan membagikan aksesnya. Saat chat dikirim, prompt, lampiran, dan API key diteruskan ke Worker dan provider yang dipilih; periksa aturan privasi kedua layanan.
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
