#!/usr/bin/env bash
# Back up the Pechu data directory to a timestamped, private tar.gz. The .env file is never included.
#   PECHU_DATA_DIR  meetings dir (as the app sees it); its PARENT is what gets backed up. Default: ./data
#   BACKUP_DIR      where archives go (default ./backups)
#   KEEP            how many newest archives to keep (default 14)
set -euo pipefail

if [[ -n "${PECHU_DATA_DIR:-}" ]]; then
  src="$(dirname "${PECHU_DATA_DIR%/}")"
else
  src="./data"
fi
backup_dir="${BACKUP_DIR:-./backups}"
keep="${KEEP:-14}"

[[ -d "$src" ]] || { echo "backup: data dir not found: $src" >&2; exit 1; }
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || { echo "backup: KEEP must be a positive integer" >&2; exit 1; }

umask 077
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$backup_dir/pechu-$stamp.tar.gz"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

# Archive top-level folder is always "data/", whatever the source dir is called.
tar -czf "$tmp" \
  --exclude='.env' --exclude='*/.env' --exclude='.env.*' --exclude='*/.env.*' \
  --transform 's,^\./,data/,;s,^\.$,data,' \
  -C "$src" .
mv "$tmp" "$out"
chmod 600 "$out"

# Keep only the newest $keep archives (names sort chronologically).
mapfile -t old < <(find "$backup_dir" -maxdepth 1 -name 'pechu-*.tar.gz' -print | sort -r | tail -n +"$((keep + 1))")
for f in "${old[@]}"; do rm -f -- "$f"; done

echo "$out"
