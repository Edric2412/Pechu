#!/usr/bin/env bash
# Restore a Pechu backup into an EMPTY (or not yet existing) directory.
#   usage: scripts/restore.sh <archive.tar.gz> <target-dir>
# The target then contains meetings/ etc. directly (no extra "data/" level).
set -euo pipefail

[[ $# -eq 2 ]] || { echo "usage: $0 <archive.tar.gz> <target-dir>" >&2; exit 2; }
archive="$1"
target="$2"

[[ -f "$archive" ]] || { echo "restore: archive not found: $archive" >&2; exit 1; }
if [[ -e "$target" ]]; then
  [[ -d "$target" ]] || { echo "restore: target is not a directory: $target" >&2; exit 1; }
  if [[ -n "$(ls -A "$target")" ]]; then
    echo "restore: refusing to overwrite non-empty directory: $target" >&2
    exit 1
  fi
fi

# Reject archives with absolute paths or ".." components.
if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "restore: archive contains unsafe paths, refusing" >&2
  exit 1
fi

# Only plain files and folders: a link inside an archive could point at any file on this machine.
if tar -tvzf "$archive" | grep -Evq '^[-d]'; then
  echo "restore: archive contains links or special files, refusing" >&2
  exit 1
fi

umask 077
mkdir -p "$target"
tar -xzf "$archive" -C "$target" --strip-components=1
echo "restored into $target"
