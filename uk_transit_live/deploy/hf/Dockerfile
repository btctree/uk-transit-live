# UK Transit Live on Hugging Face Spaces (Docker SDK, free CPU Basic).
#
# Why Docker rather than the Gradio/Streamlit SDKs: this is a plain FastAPI
# app with a Leaflet front end, not an ML demo, so it needs its own process
# and its own static routes.
#
# The Space filesystem is EPHEMERAL - it is wiped on every restart, pause or
# settings change. boot.sh restores the prebuilt caches from a Hugging Face
# Dataset repo before uvicorn starts; without that the app would re-crawl
# Overpass for the GB rail graph on every cold start, which takes hours.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

# Spaces run the container as uid 1000; anything the app writes must be owned
# by that user or the cache restore fails with permission errors.
RUN useradd -m -u 1000 app
WORKDIR /app

COPY --chown=app:app requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

COPY --chown=app:app . .
RUN mkdir -p data && chown -R app:app /app

USER app

ENV PYTHONUNBUFFERED=1 \
    PORT=7860 \
    SKIP_GTFS_PREBUILD=1

EXPOSE 7860

CMD ["bash", "deploy/hf/boot.sh"]
