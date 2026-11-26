#!/bin/sh
set -eu
cd "$(dirname "$0")/../docs/foundation"
if ! shasum -a 256 -c biome.json.sha256 >/dev/null 2>&1; then
  echo "docs/foundation/biome.json differs from its recorded hash; copy it unchanged from the foundation and update biome.json.sha256 in the same change." >&2
  exit 1
fi
