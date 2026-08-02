#!/usr/bin/env bash
# Restore the prebuilt data caches, then start the server.
#
# Spaces wipe the filesystem on every restart, so this runs on every cold
# start. Restoring ~100 MB from the Hugging Face CDN takes seconds; letting
# the app rebuild the same thing from Overpass takes hours, which is the whole
# reason this script exists.
#
# CACHE_BUNDLE_URL is set as a Space *variable* (not a secret - it is a public
# Dataset URL). If it is unset the app still boots and rebuilds lazily; it is
# just slow, so an unset URL is logged loudly rather than silently tolerated.
set -euo pipefail

cd "$(dirname "$0")/../.."      # -> app root (server.py lives here)
mkdir -p data

if [ -f data/railnet.pkl ]; then
    echo "boot: caches already present, skipping restore"
elif [ -n "${CACHE_BUNDLE_URL:-}" ]; then
    echo "boot: restoring caches from CACHE_BUNDLE_URL"
    if curl -fsSL --retry 3 --retry-delay 2 "$CACHE_BUNDLE_URL" -o /tmp/cache.tar.gz; then
        tar -xzf /tmp/cache.tar.gz -C data
        rm -f /tmp/cache.tar.gz
        echo "boot: caches restored ($(du -sh data | cut -f1))"
    else
        echo "boot: WARNING cache download failed - app will rebuild lazily (slow)"
    fi
else
    echo "boot: WARNING CACHE_BUNDLE_URL not set - app will rebuild lazily (slow)"
fi

echo "boot: starting uvicorn on ${PORT:-7860}"
exec python -m uvicorn server:app --host 0.0.0.0 --port "${PORT:-7860}"
