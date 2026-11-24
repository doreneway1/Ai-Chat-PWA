#!/bin/bash
# Siapkan Ventoy supaya antiX selalu boot dengan:
#   quiet plabel=Ventoy persist_static
# tanpa perlu mengetik lagi tiap boot.
#
# CARA PAKAI (di terminal antiX):
#   bash siapkan-ventoy-antix.sh
# Script ini TIDAK mengubah ISO. Ia hanya:
#   1. mencari file ISO antiX di flashdisk Ventoy
#   2. menyalin file boot config asli dari dalam ISO
#   3. membuat salinan yang sudah ditambah persist_static
#   4. menulis /ventoy/ventoy.json yang menunjuk ke salinan itu
# Kalau ada yang gagal, script berhenti dan bilang apa yang kurang.
#
# Script memakai sudo untuk mount ISO dan menulis ke flashdisk.
# Kalau diminta password, isi password user live (biasanya "demo").

VENTOY_PART="${VENTOY_PART:-/live/persist-dev}"   # partisi data Ventoy (tempat homefs berada)
ISO_MOUNT="/tmp/antix-iso"

echo "siapkan-ventoy-antix.sh v3 — patch kernel1.cfg (modern) + grub.cfg"
echo ""
echo "== 1. Cari file ISO antiX di flashdisk =="
ISO=$(ls "$VENTOY_PART"/*.iso 2>/dev/null | head -n 1)
if [ -z "$ISO" ]; then
  ISO=$(ls "$VENTOY_PART"/*/*.iso 2>/dev/null | head -n 1)
fi
if [ -z "$ISO" ]; then
  echo "GAGAL: file .iso tidak ketemu di $VENTOY_PART"
  echo "Cek dulu dengan: ls $VENTOY_PART"
  exit 1
fi
echo "ISO ketemu: $ISO"
ISO_NAMA=$(basename "$ISO")

echo ""
echo "== 2. Buka isi ISO (read-only, ISO tidak diubah) =="
sudo mkdir -p "$ISO_MOUNT"
sudo mount -o loop,ro "$ISO" "$ISO_MOUNT" 2>/dev/null || sudo mount -o loop "$ISO" "$ISO_MOUNT"
if ! mountpoint -q "$ISO_MOUNT"; then
  echo "GAGAL: ISO tidak bisa di-mount."
  exit 1
fi

echo ""
echo "== 3. Cari file boot config di dalam ISO =="
ISOLINUX_CFG=$(find "$ISO_MOUNT" -name "isolinux.cfg" 2>/dev/null | head -n 1)
GRUB_CFG=$(find "$ISO_MOUNT" -name "grub.cfg" 2>/dev/null | head -n 1)
echo "isolinux.cfg: ${ISOLINUX_CFG:-tidak ketemu}"
echo "grub.cfg:     ${GRUB_CFG:-tidak ketemu}"
if [ -z "$ISOLINUX_CFG" ] && [ -z "$GRUB_CFG" ]; then
  echo "GAGAL: tidak ada file boot config yang dikenali."
  sudo umount "$ISO_MOUNT"
  exit 1
fi

# antiX 26 memisah entri boot per kernel: isolinux.cfg hanya berisi menu
# utama dengan CONFIG ke kernel0.cfg (legacy) / kernel1.cfg (modern) —
# baris boot yang sebenarnya ada di file kernel itu, bukan di isolinux.cfg.
# Ventoy hanya boleh mengganti maks. 2 file per ISO, jadi yang dipakai
# adalah kernel modern (kernel1.cfg). Kalau tidak ada, fallback ke
# kernel0.cfg, lalu ke isolinux.cfg itu sendiri (ISO lama).
KERNEL_CFG=""
if [ -n "$ISOLINUX_CFG" ]; then
  ISOLINUX_DIR=$(dirname "$ISOLINUX_CFG")
  for cand in "$ISOLINUX_DIR/kernel1.cfg" "$ISOLINUX_DIR/kernel0.cfg" "$ISOLINUX_CFG"; do
    if [ -f "$cand" ] && grep -qi "^[[:space:]]*append[[:space:]].*initrd=" "$cand"; then
      KERNEL_CFG="$cand"
      break
    fi
  done
fi
echo "config kernel syslinux: ${KERNEL_CFG:-tidak ketemu (tidak ada baris boot)}"

sudo mkdir -p "$VENTOY_PART/ventoy"

tambah_param() {
  # $1 = file asli, $2 = file hasil, $3 = pola baris boot
  # Tambahkan ke SEMUA baris boot yang cocok — tiap entri menu punya
  # barisnya sendiri (mis. entri kernel biasa dan kernel modern).
  # Return 1 kalau tidak ada baris boot yang cocok (supaya tidak
  # "sukses" diam-diam seperti yang pernah terjadi).
  local asal="$1" hasil="$2" pola="$3"
  local n
  n=$(grep -ci "$pola" "$asal" 2>/dev/null || true)
  n=${n:-0}
  if [ "$n" = "0" ]; then
    echo "  PERINGATAN: tidak ada baris boot yang cocok di file ini — dilewati."
    return 1
  fi
  sudo cp "$asal" "$hasil"
  if grep -q "persist_static" "$hasil"; then
    echo "  (sudah ada persist_static, tidak diubah)"
    return 0
  fi
  # (awk, bukan sed: sed dengan range 0,/pola/ akan ikut mengubah
  #  baris-baris sebelum baris boot — sudah terbukti di tes.)
  # Hasil awk ditulis ke /tmp dulu lalu dipindah pakai sudo,
  # supaya tetap jalan walau partisi Ventoy tidak bisa ditulis user biasa.
  # Pencocokan case-insensitive (tolower): config antiX memakai APPEND
  # huruf besar, ISO lain bisa memakai append huruf kecil.
  awk -v pat="$pola" '{ if (tolower($0) ~ pat) { $0=$0" plabel=Ventoy persist_static" } print }' "$asal" > /tmp/antix-cfg.tmp && sudo mv /tmp/antix-cfg.tmp "$hasil"
  # Verifikasi: kalau tidak ada baris yang berubah, anggap gagal
  # (jangan "sukses" diam-diam).
  if ! grep -q "persist_static" "$hasil"; then
    echo "  PERINGATAN: penambahan parameter gagal (tidak ada baris yang berubah) — dilewati."
    return 1
  fi
  echo "  --- sebelum ($n baris) ---"
  grep -i "$pola" "$asal"
  echo "  --- sesudah ---"
  grep -i "$pola" "$hasil"
  return 0
}

LEGACY_ORG=""
LEGACY_NEW=""
UEFI_ORG=""
UEFI_NEW=""
if [ -n "$KERNEL_CFG" ]; then
  echo ""
  echo "== 4a. Buat salinan config kernel syslinux (mode BIOS/Legacy) =="
  REL_KERNEL="${KERNEL_CFG#$ISO_MOUNT}"
  KERNEL_BASE=$(basename "$KERNEL_CFG")
  if tambah_param "$KERNEL_CFG" "$VENTOY_PART/ventoy/antix-$KERNEL_BASE" "^[[:space:]]*append[[:space:]].*initrd="; then
    LEGACY_ORG="$REL_KERNEL"
    LEGACY_NEW="/ventoy/antix-$KERNEL_BASE"
  fi
fi
if [ -n "$GRUB_CFG" ]; then
  echo ""
  echo "== 4b. Buat salinan grub (mode UEFI) =="
  REL_GRUB="${GRUB_CFG#$ISO_MOUNT}"
  if tambah_param "$GRUB_CFG" "$VENTOY_PART/ventoy/antix-grub.cfg" "^[[:space:]]*linux[[:space:]].*/antix/"; then
    UEFI_ORG="$REL_GRUB"
    UEFI_NEW="/ventoy/antix-grub.cfg"
  fi
fi

echo ""
echo "== 5. Tulis ventoy.json =="
# ISO path di ventoy.json dihitung dari root partisi Ventoy.
ISO_REL="/${ISO#$VENTOY_PART/}"
CONF_TMP="/tmp/ventoy-conf.json.tmp"
{
  echo "{"
  echo '    "conf_replace": ['
  FIRST=1
  if [ -n "$LEGACY_ORG" ]; then
    [ "$FIRST" = 0 ] && echo ","
    echo '        {'
    echo "            \"iso\": \"$ISO_REL\","
    echo "            \"org\": \"$LEGACY_ORG\","
    echo "            \"new\": \"$LEGACY_NEW\""
    echo '        }'
    FIRST=0
  fi
  if [ -n "$UEFI_ORG" ]; then
    [ "$FIRST" = 0 ] && echo ","
    echo '        {'
    echo "            \"iso\": \"$ISO_REL\","
    echo "            \"org\": \"$UEFI_ORG\","
    echo "            \"new\": \"$UEFI_NEW\""
    echo '        }'
    FIRST=0
  fi
  echo '    ]'
  echo "}"
} > "$CONF_TMP"
# Gabung dengan ventoy.json yang sudah ada (kalau ada), supaya
# pengaturan lain (mis. persistence) tidak hilang. Buat cadangan dulu.
VENTOY_JSON="$VENTOY_PART/ventoy/ventoy.json"
JSON_TMP="/tmp/ventoy.json.tmp"
if [ -f "$VENTOY_JSON" ]; then
  echo "ventoy.json sudah ada — dibuat cadangannya (.bak) dan digabung."
  sudo cp "$VENTOY_JSON" "$VENTOY_JSON.bak"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$VENTOY_JSON" "$CONF_TMP" "$JSON_TMP" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        existing = json.load(f)
except Exception as e:
    print("ventoy.json lama tidak valid (%s), diganti dengan yang baru." % e)
    existing = {}
# Hapus key mode-spesifik dari versi lama script (diganti conf_replace biasa
# yang kompatibel dengan semua versi Ventoy).
existing.pop("conf_replace_legacy", None)
existing.pop("conf_replace_uefi", None)
with open(sys.argv[2]) as f:
    new = json.load(f)
existing.update(new)
with open(sys.argv[3], "w") as f:
    json.dump(existing, f, indent=4)
    f.write("\n")
PYEOF
  fi
  [ -s "$JSON_TMP" ] || cp "$CONF_TMP" "$JSON_TMP"
else
  cp "$CONF_TMP" "$JSON_TMP"
fi
# Validasi JSON sebelum dipasang (kalau python3 tersedia).
if command -v python3 >/dev/null 2>&1; then
  if python3 -m json.tool "$JSON_TMP" >/dev/null 2>&1; then
    echo "JSON valid."
  else
    echo "GAGAL: ventoy.json yang dibuat tidak valid, dibatalkan."
    sudo umount "$ISO_MOUNT"
    exit 1
  fi
fi
sudo mv "$JSON_TMP" "$VENTOY_JSON"
cat "$VENTOY_JSON"
# Bersihkan salinan config lama yang sudah tidak dipakai lagi
# (mis. antix-isolinux.cfg dari versi lama script).
for lama in "$VENTOY_PART"/ventoy/antix-*.cfg; do
  [ -f "$lama" ] || continue
  base="/ventoy/$(basename "$lama")"
  if [ "$base" != "$LEGACY_NEW" ] && [ "$base" != "$UEFI_NEW" ]; then
    sudo rm -f "$lama" && echo "Hapus salinan lama yang tidak dipakai: $lama"
  fi
done

sudo umount "$ISO_MOUNT"
echo ""
echo "== SELESAI =="
echo "File yang dibuat di flashdisk:"
ls -la "$VENTOY_PART/ventoy/"
echo ""
echo "Langkah berikut:"
echo "  1. Reboot laptop, pilih antiX di menu Ventoy seperti biasa."
echo "  2. Jangan ketik apa-apa di layar boot — biarkan jalan sendiri."
echo "  3. Setelah masuk desktop, cek:  mount | grep rootfs"
echo "     Kalau rootfs muncul, persistence aktif. Baru install Brave lagi,"
echo "     reboot sekali lagi, dan Brave harusnya tetap ada."
echo "  4. Kalau boot gagal / masuk menu aneh: kembalikan ventoy.json"
echo "     dari cadangannya lalu reboot — kembali seperti semula:"
echo "     sudo cp $VENTOY_PART/ventoy/ventoy.json.bak $VENTOY_PART/ventoy/ventoy.json"
