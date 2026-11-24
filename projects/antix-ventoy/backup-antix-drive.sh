#!/bin/bash
# backup-antix-drive.sh — backup rootfs+homefs terkompresi untuk diunggah ke Drive.
#
# Bedanya dengan backup-antix.sh (yang menyalin mentah 6GB): script ini
# mengompres sambil membaca (streaming), jadi hanya butuh ~2GB ruang
# sementara di flashdisk — penting karena partisi Ventoy tinggal 7,5G kosong.
#
# CARA PAKAI (dijalankan Muse via SSH, setelah reboot, Brave tertutup):
#   bash backup-antix-drive.sh
#     -> hasil di /live/persist-dev/backup-antix-drive/backup-YYYY-MM-DD_HHMM/
#        berisi rootfs.zst (atau .gz) + homefs.zst (atau .gz) + SHA256SUMS
#
# Verifikasi: sha256 sumber dihitung dulu, lalu hasil kompresi dibuka lagi
# dan dihitung sha256-nya — kalau tidak cocok berarti file berubah saat
# dibaca, script mengulang sekali lalu berhenti dengan pesan jelas.
#
# ENKRIPSI (diketik user sendiri di terminal, passphrase tidak dibagikan):
#   gpg --symmetric --cipher-algo AES256 <file>.zst
#     -> menghasilkan <file>.zst.gpg ; file .zst mentah lalu dihapus.
# Setelah itu Muse mengunduh file .gpg dan mengunggahnya ke Google Drive.

set -e
PERSIST_DIR="${PERSIST_DIR:-/live/persist-dev/antiX}"
DEST_BASE="${1:-/live/persist-dev/backup-antix-drive}"
ROOTFS="$PERSIST_DIR/rootfs"
HOMEFS="$PERSIST_DIR/homefs"

# Pilih kompresor: zstd kalau ada (cepat + rasio bagus), kalau tidak gzip.
if command -v zstd >/dev/null 2>&1; then
  COMPRESS="zstd -10 -q"
  DECOMPRESS="zstd -d -c -q"
  EXT="zst"
else
  COMPRESS="gzip -6"
  DECOMPRESS="gzip -d -c"
  EXT="gz"
fi
echo "Kompresor: $EXT"

for f in "$ROOTFS" "$HOMEFS"; do
  if [ ! -f "$f" ]; then echo "GAGAL: $f tidak ketemu."; exit 1; fi
  ls -lh "$f"
done

STAMP=$(date +%Y-%m-%d_%H%M)
DEST="$DEST_BASE/backup-$STAMP"
mkdir -p "$DEST"

backup_one() {
  local src="$1" name="$2" out="$DEST/$name.$EXT"
  local attempt h_src h_dec
  for attempt in 1 2; do
    echo ""
    echo "== $name (percobaan $attempt): hitung sha256 sumber =="
    h_src=$(sha256sum "$src" | awk '{print $1}')
    echo "== $name: kompres streaming ke $out =="
    sync
    cat "$src" | $COMPRESS > "$out"
    sync
    echo "== $name: verifikasi (buka lagi + sha256) =="
    h_dec=$($DECOMPRESS "$out" | sha256sum | awk '{print $1}')
    if [ "$h_src" = "$h_dec" ]; then
      echo "== $name: OK, isi cocok =="
      ls -lh "$out"
      return 0
    fi
    echo "PERINGATAN: $name berubah saat dibaca (sha256 tidak cocok)."
    rm -f "$out"
    if [ "$attempt" = 2 ]; then
      echo "GAGAL setelah 2 percobaan. Tutup semua aplikasi, reboot, lalu ulangi."
      exit 1
    fi
    echo "Mengulang..."
    sleep 5
  done
}

backup_one "$ROOTFS" rootfs
backup_one "$HOMEFS" homefs

echo ""
echo "== SHA256SUMS =="
(cd "$DEST" && sha256sum "rootfs.$EXT" "homefs.$EXT" > SHA256SUMS && cat SHA256SUMS)

echo ""
echo "== SELESAI =="
du -sh "$DEST"
ls -lh "$DEST"
echo ""
echo "Langkah berikut (user, di terminal laptop):"
echo "  gpg --symmetric --cipher-algo AES256 $DEST/rootfs.$EXT"
echo "  gpg --symmetric --cipher-algo AES256 $DEST/homefs.$EXT"
echo "  rm $DEST/rootfs.$EXT $DEST/homefs.$EXT"
echo "Lalu kabari Muse untuk mengunggah file .gpg ke Drive."
