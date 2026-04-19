#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f metadata.json ]]; then
    echo "build.sh: metadata.json not found in $SCRIPT_DIR" >&2
    exit 1
fi

OUT_DIR="${OUT_DIR:-$PWD/dist}"
ZIP_NAME="token_gauge@oswald.dev.shell-extension.zip"
mkdir -p "$OUT_DIR"

if [[ -x "$HOME/venv/bin/shexli" ]]; then
    SHEXLI="$HOME/venv/bin/shexli"
elif command -v shexli >/dev/null 2>&1; then
    SHEXLI="$(command -v shexli)"
else
    echo "build.sh: shexli not found (expected at ~/venv/bin/shexli or on PATH)" >&2
    exit 1
fi

TMP_DIR="$(mktemp -d -t token-gauge-build-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "build.sh: packaging extension..."
gnome-extensions pack \
    --force \
    --out-dir "$TMP_DIR" \
    --extra-source=lib \
    --extra-source=stylesheet.css \
    --extra-source=LICENSE \
    .

TMP_ZIP="$TMP_DIR/$ZIP_NAME"
if [[ ! -f "$TMP_ZIP" ]]; then
    echo "build.sh: expected $TMP_ZIP was not produced" >&2
    exit 1
fi

echo "build.sh: linting with shexli..."
"$SHEXLI" "$TMP_ZIP"

mv -f "$TMP_ZIP" "$OUT_DIR/$ZIP_NAME"

SIZE="$(stat -c%s "$OUT_DIR/$ZIP_NAME")"
echo "build.sh: built $OUT_DIR/$ZIP_NAME (${SIZE} bytes)"
