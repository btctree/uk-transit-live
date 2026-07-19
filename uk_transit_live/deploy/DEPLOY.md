# Running UK Transit Live in the cloud, free

## Recommended: Oracle Cloud always-free VM (you already have one)
Oracle's Always Free tier (4 ARM cores / 24 GB RAM / 200 GB disk) runs 24/7 at
no cost - the same offer your other VM uses. GitHub cannot host live servers
(Actions are batch jobs; Pages is static files only), and most "free" PaaS
tiers sleep or expire.

1. Push this folder to a **private** GitHub repo (the .gitignore keeps your
   .env keys and the big data/ caches out).
2. On the VM: `sudo git clone <repo> /opt/uk-transit`
3. Copy your `.env` to `/opt/uk-transit/uk_transit_live/.env`
4. `sudo bash /opt/uk-transit/uk_transit_live/deploy/setup_server.sh`
5. Oracle console -> VCN security list -> allow TCP 8620 (or put nginx/Caddy
   with HTTPS in front - needed for phone geolocation + PWA install).
6. Optional auto-deploy: add the three secrets and every `git push` updates
   the server via .github/workflows/deploy.yml.

First boot downloads NaPTAN (~100 MB) and builds region timetables on demand;
they persist on disk afterwards. Rail Data Marketplace / BODS keys are per
account, not per machine - the same keys work from the VM.

## Alternatives considered
- GitHub Pages/Actions: static only / 6h job limit - not suitable.
- Render/Railway free tiers: sleep on idle, ephemeral disk (would re-download
  NaPTAN+GTFS on every wake), or trial credit that runs out.
- Fly.io: no longer meaningfully free.
