#!/usr/bin/env bash
# Build the cache bundle that boot.sh restores on every Space cold start.
#
# Ships the expensive-to-rebuild caches only (~101 MB raw). Deliberately
# excluded: gtfs_*.sqlite (2.7 GB - rebuildable from the zips) and gtfs_*.zip
# (549 MB). Including those would make every cold start a multi-minute
# download for features that degrade gracefully without them.
#
# Usage:  bash deploy/hf/make_bundle.sh [output.tar.gz]
# Then upload the result to a Hugging Face Dataset repo and point the Space's
# CACHE_BUNDLE_URL variable at its resolve/main URL.
set -euo pipefail

cd "$(dirname "$0")/../.."          # -> uk_transit_live/
OUT="${1:-/tmp/uk-transit-caches.tar.gz}"

[ -d data ] || { echo "no data/ directory - run the app locally first"; exit 1; }
[ -f data/railnet.pkl ] || { echo "data/railnet.pkl missing - the rail graph has not been built"; exit 1; }

echo "packing..."
tar -czf "$OUT" -C data \
    railnet.pkl \
    stops_gb.json \
    rail_stations.json \
    railnet_tiles \
    railpaths \
    $(cd data && ls geom_*.json)

echo "bundle: $OUT"
ls -lh "$OUT" | awk '{print "  size:", $5}'
echo
echo "next: upload to a Dataset repo, then set the Space variable"
echo "  CACHE_BUNDLE_URL=https://huggingface.co/datasets/<user>/<repo>/resolve/main/$(basename "$OUT")"
