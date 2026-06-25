#!/usr/bin/env bash
#
# backup.sh — make a COMPLETE backup of everything Perch stores: the
# account/site records AND the actual site files (including drag-drop
# uploads that don't live on GitHub), as one compressed file.
#
#   cd /opt/perch && sudo bash scripts/backup.sh
#
# IMPORTANT: copy the resulting file OFF the server (your laptop, Google
# Drive, etc.) — a backup that only lives on the droplet won't help if the
# droplet itself dies.

set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="backups-full"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
FILE="$OUT_DIR/perch-backup-$STAMP.tgz"

echo "Packing up everything in data/ ..."
tar czf "$FILE" data

echo "Backup written to:"
ls -lh "$FILE"

# Keep only the last 7 full backups on the server (so they don't pile up).
ls -1t "$OUT_DIR"/perch-backup-*.tgz | tail -n +8 | xargs -r rm -f

echo
echo "Done. Now copy that .tgz file off the server to be fully safe."
