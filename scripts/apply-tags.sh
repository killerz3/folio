#!/usr/bin/env bash
# Apply scripts/tags.json (folder + subtags per doc id, picked by a haiku
# subagent per document) to a running folio instance via its own API.
#
# Safe to run only AFTER the server has been redeployed with folder/tags
# support (sudo ./install.sh && sudo systemctl restart folio) — older server
# code silently ignores unknown PATCH fields instead of applying them.
#
# Usage: ./scripts/apply-tags.sh [path/to/tags.json]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAGS_FILE="${1:-$ROOT/scripts/tags.json}"
FOLIO="folio"

command -v "$FOLIO" >/dev/null || { echo "folio CLI not found on PATH (try: PATH=\"$ROOT/bin:\$PATH\")" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

node --input-type=module -e '
import fs from "node:fs";
const tags = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const [id, v] of Object.entries(tags)) {
  process.stdout.write(`${id}\t${v.folder ?? ""}\t${(v.tags ?? []).join(",")}\n`);
}
' "$TAGS_FILE" | while IFS=$'\t' read -r id folder tags; do
  echo "tagging $id -> folder=$folder tags=$tags"
  args=(tag "$id")
  [ -n "$folder" ] && args+=(--folder "$folder")
  if [ -n "$tags" ]; then
    IFS=',' read -ra TAGLIST <<< "$tags"
    for t in "${TAGLIST[@]}"; do args+=(--tag "$t"); done
  fi
  "$FOLIO" "${args[@]}"
done

echo "done — verify with: folio list"
