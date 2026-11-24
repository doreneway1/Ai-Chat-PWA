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
2. Membuka isi ISO (read-only) dan mencari `isolinux.cfg` (BIOS) / `grub.cfg` (UEFI).
3. Menyalin config itu ke `/ventoy/` di flashdisk, dengan tambahan
   `plabel=Ventoy persist_static` di **baris boot pertama saja**.
4. Menulis `/ventoy/ventoy.json` yang menunjuk ke salinan tersebut
   (dipakai key `conf_replace_legacy` / `conf_replace_uefi` sesuai
   dokumentasi Ventoy; JSON divalidasi dulu sebelum dipasang).
5. Menampilkan sebelum/sesudah supaya bisa dicek sebelum reboot.

Script memakai `sudo` untuk mount ISO dan menulis ke flashdisk
(kalau diminta password, isi password user live, biasanya `demo`).

Logika editnya sudah dites di sini (24 Nov 2026): tepat 1 baris yang
berubah per file, entri boot lain tidak tersentuh, dan `ventoy.json`
valid untuk ketiga kasus (BIOS saja, UEFI saja, keduanya).

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

## Kalau gagal

Hapus `/ventoy/ventoy.json` di flashdisk, reboot — boot kembali seperti semula.
Plugin ini hanya jalan di mode boot normal Ventoy, bukan memdisk/grub2 mode
(dokumen Ventoy, plugin_bootconf_replace).

## Batasan yang masih perlu dicek di laptop

- Nama file ISO dan lokasi persis `isolinux.cfg`/`grub.cfg` di dalam ISO
  berbeda-beda tiap versi antiX — makanya script mencarinya sendiri, bukan
  menebak. Kalau script bilang "tidak ketemu", kirim output-nya, jangan dipaksa.
- Script mengasumsikan partisi data Ventoy ada di `/live/persist-dev`
  (sesuai output `mount` user: homefs ter-mount dari sana).
