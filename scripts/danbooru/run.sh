#!/usr/bin/env bash
# Builds danbooruTags.ts in this folder from Danbooru (see README.md).
# The app's copy (src/workflow/danbooruTags.ts) is left alone — copy it over
# yourself when it looks right.
#   ./run.sh                 use cached downloads where present
#   ./run.sh --refresh       re-download everything (fresh pages + counts)
#   OUT=/tmp/x.ts ./run.sh   write somewhere else instead
set -euo pipefail
cd "$(dirname "$0")"
if [[ "${1:-}" == "--refresh" ]]; then
  rm -rf cache
fi
python3 1_fetch_pages.py
python3 2_parse.py
python3 3_counts.py
python3 4_emit.py
node 5_finalize.mjs ${OUT:+"$OUT"}
