#!/bin/bash
# Backup rootfs + homefs antiX — cadangan satu perintah.
#
# Kenapa perlu: laptop ini tanpa hard disk, flashdisk adalah "jantungnya".
# rootfs dan homefs itu cuma dua file di flashdisk. Kalau salah satunya
# rusak (update gagal, salah hapus, stik error), sistem bisa hidup lagi
# dalam hitungan menit selama dua file ini ada cadangannya.
#
# CARA PAKAI (di terminal antiX):
#   bash backup-antix.sh
#     -> cadangan disimpan di flashdisk yang sama:
#        /live/persist-dev/backup-antix/backup-YYYY-MM-DD_HHMM/
#        (melindungi dari update gagal / file rusak, tapi TIDAK dari
#         stik yang mati total)
#   bash backup-antix.sh /media/nama-flashdisk-kedua
#     -> cadangan disimpan di flashdisk kedua — ini yang paling aman,
#        karena kalau stik utama mati, cadangannya tetap ada.
#
# SEBELUM JALAN: tutup Brave dan semua aplikasi dulu, lalu jalankan
# segera setelah boot supaya file tidak berubah saat disalin. Proses
# verifikasi (sha256sum) membaca ulang file, jadi butuh beberapa menit
# di USB 2.0 — itu normal, jangan dibatalkan.
#
# RESTORE (kalau suatu hari perlu): JANGAN timpa file saat sedang boot
# dari persistence itu sendiri. Boot dari live USB lain (atau dari
# Ventoy tanpa persist), lalu salin balik:
#   cp -a /tempat-cadangan/backup-YYYY-MM-DD_HHMM/rootfs  /live/persist-dev/antiX/rootfs
#   cp -a /tempat-cadangan/backup-YYYY-MM-DD_HHMM/homefs /live/persist-dev/antiX/homefs
#
# Script ini TIDAK mengubah rootfs/homefs yang aktif, hanya membaca
# dan menyalinnya. Cadangan lama otomatis dihapus, hanya 2 terbaru
# yang disimpan supaya flashdisk tidak penuh.

set -e
PERSIST_DIR="${PERSIST_DIR:-/live/persist-dev/antiX}"
DEST_BASE="${1:-/live/persist-dev/backup-antix}"

ROOTFS="$PERSIST_DIR/rootfs"
HOMEFS="$PERSIST_DIR/homefs"

echo "== 1. Cek file persistence =="
for f in "$ROOTFS" "$HOMEFS"; do
  if [ ! -f "$f" ]; then
    echo "GAGAL: $f tidak ketemu."
    echo "Cek dulu dengan: ls -la $PERSIST_DIR"
    exit 1
  fi
  ls -lh "$f"
done

echo ""
echo "== 2. Cek ruang kosong di tujuan =="
mkdir -p "$DEST_BASE"
BUTUH=$(du -sb "$ROOTFS" "$HOMEFS" | awk '{s+=$1} END {print s}')
TERSEDIA=$(df --output=avail -B1 "$DEST_BASE" | tail -n 1)
echo "Butuh: $BUTUH byte, tersedia: $TERSEDIA byte"
if [ "$TERSEDIA" -lt "$BUTUH" ]; then
  echo "GAGAL: ruang kosong tidak cukup untuk cadangan."
  exit 1
fi

STAMP=$(date +%Y-%m-%d_%H%M)
DEST="$DEST_BASE/backup-$STAMP"
mkdir -p "$DEST"

echo ""
echo "== 3. Salin (tutup semua aplikasi dulu, jangan dibatalkan) =="
sync
cp -a "$ROOTFS" "$DEST/rootfs"
cp -a "$HOMEFS" "$DEST/homefs"
sync

echo ""
echo "== 4. Verifikasi isi salinan =="
ls -lh "$DEST"
if [ "$(stat -c%s "$ROOTFS")" != "$(stat -c%s "$DEST/rootfs")" ] || \
   [ "$(stat -c%s "$HOMEFS")" != "$(stat -c%s "$DEST/homefs")" ]; then
  echo "PERINGATAN: ukuran salinan tidak sama dengan aslinya."
  echo "Cadangan ini jangan dipakai — ulangi setelah reboot dengan semua aplikasi tertutup."
  exit 1
fi
echo "Ukuran cocok. Memeriksa isi file (beberapa menit, mohon tunggu)..."
if sha256sum "$ROOTFS" "$DEST/rootfs" | awk '{print $1}' | uniq -c | grep -q " 2 " && \
   sha256sum "$HOMEFS" "$DEST/homefs" | awk '{print $1}' | uniq -c | grep -q " 2 "; then
  echo "Isi file cocok (sha256 sama)."
else
  echo "PERINGATAN: isi salinan berbeda dari aslinya — file mungkin berubah saat disalin."
  echo "Cadangan ini jangan dipakai — ulangi setelah reboot dengan semua aplikasi tertutup."
  exit 1
fi

echo ""
echo "== 5. Bersihkan cadangan lama (simpan 2 terbaru saja) =="
# shellcheck disable=SC2012
ls -dt "$DEST_BASE"/backup-*/ 2>/dev/null | tail -n +3 | while read -r lama; do
  echo "Hapus cadangan lama: $lama"
  rm -rf "$lama"
done

echo ""
echo "== SELESAI =="
echo "Cadangan tersimpan di: $DEST"
du -sh "$DEST"
echo "Sisa cadangan di $DEST_BASE:"
ls -dt "$DEST_BASE"/backup-*/ 2>/dev/null
