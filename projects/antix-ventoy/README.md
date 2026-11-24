# antiX di Ventoy — boot otomatis dengan persist_static

Masalah: tiap boot harus mengetik `plabel=Ventoy` manual, dan tanpa
`persist_static` Brave (dan semua aplikasi yang di-install) hilang tiap reboot.
Penyebabnya sudah ketemu dari screenshot terminal: baris boot cuma
`quiet plabel=Ventoy` (tanpa mode persistence) dan yang ter-mount cuma `homefs`.

## Yang disiapkan

`siapkan-ventoy-antix.sh` — script yang dijalankan sekali di terminal antiX.
Ia memakai plugin resmi Ventoy **Boot Conf Replace** (`conf_replace` di
`/ventoy/ventoy.json`): Ventoy mengganti file boot config di dalam ISO secara
virtual tiap boot, ISO aslinya tidak diubah. Jadi parameter boot nempel terus.

Script ini:
1. Mencari file ISO antiX di flashdisk Ventoy.
2. Membuka isi ISO (read-only) dan mencari file boot config. antiX 26
   memisah entri boot per kernel: `isolinux.cfg` hanya berisi menu utama
   dengan `CONFIG` ke `kernel0.cfg` (legacy) / `kernel1.cfg` (modern) —
   baris boot yang sebenarnya ada di file kernel itu. Script memakai
   `kernel1.cfg` (modern); Ventoy hanya boleh mengganti maks. 2 file
   per ISO, jadi entri legacy kernel tidak di-patch (kalau boot legacy,
   ketik manual). Sisi UEFI memakai `grub.cfg`.
3. Menyalin config itu ke `/ventoy/` di flashdisk, dengan tambahan
   `plabel=Ventoy persist_static` di **semua baris boot** (hanya baris
   boot antiX yang diubah, entri lain seperti memtest tidak disentuh).
   Kalau tidak ada baris boot yang cocok, script memberi peringatan
   dan melewati file itu (tidak "sukses" diam-diam).
4. Menulis `/ventoy/ventoy.json` yang menunjuk ke salinan tersebut
   (dipakai key `conf_replace` biasa sesuai dokumentasi Ventoy —
   kompatibel dengan semua versi Ventoy; JSON divalidasi dulu sebelum
   dipasang).
   Kalau `ventoy.json` sudah ada (mis. berisi setting `persistence`),
   script menggabungkan, bukan menimpa — pengaturan lama dipertahankan
   dan dibuat cadangannya (`ventoy.json.bak`).
5. Menampilkan sebelum/sesudah supaya bisa dicek sebelum reboot.

Script memakai `sudo` untuk mount ISO dan menulis ke flashdisk
(kalau diminta password, isi password user live, biasanya `demo`).

Logika editnya sudah dites di sini (24 Nov 2026): semua baris boot
antiX ter-patch (kernel biasa + modern), entri lain tidak tersentuh,
dan `ventoy.json` valid untuk semua kasus (BIOS saja, UEFI saja,
keduanya, merge dengan ventoy.json lama, dan struktur CONFIG
kernel0/kernel1.cfg).

## Cara pakai

1. Pastikan dulu file `rootfs` ada (langkah 1 dari rencana sebelumnya):
   `ls -la /live/persist-dev/antiX/` — harus ada `rootfs` di samping `homefs`.
   Kalau belum ada, `persist_static` akan menawarkan membuatnya saat boot
   (karena pakai tanda `!` = wajib), jadi tetap bisa lanjut.
2. Jalankan script di terminal antiX: `bash siapkan-ventoy-antix.sh`
3. Reboot, pilih antiX di menu Ventoy, **jangan ketik apa-apa** di layar boot.
4. Setelah masuk desktop, cek: `mount | grep rootfs`
   Kalau rootfs muncul → persistence aktif. Install Brave, reboot sekali lagi,
   Brave harusnya tetap ada.

## Backup rootfs + homefs

`backup-antix.sh` — cadangan satu perintah untuk dua file persistence.
Jalankan di terminal antiX setelah menutup Brave dan semua aplikasi:

```
bash backup-antix.sh                          # simpan di flashdisk yang sama
bash backup-antix.sh /media/flashdisk-kedua   # simpan di flashdisk kedua (paling aman)
```

Script mengecek ruang kosong, menyalin kedua file, memverifikasi ukuran
dan sha256, lalu menyimpan hanya 2 cadangan terbaru. Restore harus dari
boot lain (bukan dari persistence yang sedang dipakai) — caranya tertulis
di kepala script. Sudah dites 24 Nov 2026 dengan file palsu: salin,
verifikasi sha256, dan prune ke 2 terbaru semuanya jalan.

## Kalau gagal

Kembalikan `ventoy.json` dari cadangannya, reboot — boot kembali seperti
semula:

```
sudo cp /live/persist-dev/ventoy/ventoy.json.bak /live/persist-dev/ventoy/ventoy.json
```

(Kalau tidak ada file `.bak`, berarti `ventoy.json` belum pernah ada
sebelumnya — hapus saja file `ventoy.json` itu.)
Plugin ini hanya jalan di mode boot normal Ventoy, bukan memdisk/grub2 mode
(dokumen Ventoy, plugin_bootconf_replace).

## Batasan yang masih perlu dicek di laptop

- Nama file ISO dan lokasi persis `isolinux.cfg`/`grub.cfg` di dalam ISO
  berbeda-beda tiap versi antiX — makanya script mencarinya sendiri, bukan
  menebak. Kalau script bilang "tidak ketemu", kirim output-nya, jangan dipaksa.
- Script mengasumsikan partisi data Ventoy ada di `/live/persist-dev`
  (sesuai output `mount` user: homefs ter-mount dari sana).
