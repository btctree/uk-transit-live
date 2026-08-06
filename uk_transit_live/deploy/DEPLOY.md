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

## Public URL: why a Cloudflare Worker sits in front

**Use https://go.ukt.workers.dev** — that is the address to share and to install
on a phone.

The origin is an Oracle A1 VM at a *reserved* (permanent) public IP,
145.241.199.54, with Caddy terminating HTTPS. It is directly reachable at
`https://145.241.199.54.sslip.io` and `https://145.241.199.54.nip.io`
(two independent free wildcard-DNS services, so a hiccup in one leaves a
working URL). Those are the origin fallbacks, still valid.

They are **not** the public URL, because they do not work on UK mobile data.
O2/giffgaff's filter kills the TLS handshake to destinations its categorisation
engine does not recognise, which includes raw IPs and free wildcard-DNS names —
they share a reputation bucket with malware infrastructure. The symptom is
"Safari cannot open the page because it could not establish a secure
connection", **on mobile data only**, while wifi works and the server logs show
the request never arrived at all. Diagnosed by proving a Cloudflare-hosted
hostname loaded on the same phone, same network, same instant, while the raw IP
did not.

So `deploy/cf-worker.js` runs as a Cloudflare Worker (account subdomain `ukt`,
worker `go`) and proxies to the origin. workers.dev is a categorised, clean
hostname, so mobile networks pass it.

Watch out for:

- **The Worker's live copy is edited in the Cloudflare dashboard**, not from
  this repo. `deploy/cf-worker.js` is the reference copy — change one, change
  both, or they silently diverge.
- **Free plan: 100,000 requests/day, account-wide.** This app polls constantly,
  so a few concurrent viewers are fine and a crowd is not. If that ever binds,
  buy a domain (~£4–10/yr), point it at 145.241.199.54, and drop the Worker
  entirely — the origin already serves HTTPS.
- **The account is separate on purpose** (`bho.1228+uktransit@gmail.com`) so the
  request quota is not shared with another product's Workers.

The IP is reserved, so it survives instance rebuilds — re-attach it to a
replacement VM and every URL above keeps working unchanged.

## Unattended: hunt and deploy from GitHub Actions

`uk-london-1` is chronically out of Always Free Arm capacity, so getting a VM
means asking repeatedly until one is released. Running that on a laptop only
works while the laptop is awake - a sleeping machine managed 13 attempts in a
day where an awake one managed 805.

`.github/workflows/hunt.yml` moves it off the laptop: every 20 minutes it runs
`deploy/oci_hunt_once.py` for four minutes, and the first run that wins goes
straight on to deploy the app via `deploy/ci_deploy.sh`. Standard runners are
free on public repositories, so this costs nothing.

### One-time setup

1. **Make a compartment for this project.** Identity -> Compartments ->
   Create, named e.g. `uk-transit`. This is what bounds the damage if the CI
   credential ever leaks: the instance is created inside it, while the shared
   VCN stays in root. Instances and subnets may live in different
   compartments, so nothing has to move.

2. **Create a restricted OCI user for CI.** Do not reuse your admin API key -
   the same tenancy holds your other products' VMs, and an admin key can
   terminate them. Create user `ci-hunter`, put it in a group `ci-hunters`,
   then add a policy in the *root* compartment:

   ```
   Allow group ci-hunters to manage instance-family in compartment uk-transit
   Allow group ci-hunters to read instance-family in tenancy
   Allow group ci-hunters to use subnets in tenancy
   Allow group ci-hunters to use vnics in tenancy
   Allow group ci-hunters to read virtual-network-family in tenancy
   Allow group ci-hunters to read app-catalog-listing in tenancy
   Allow group ci-hunters to inspect compartments in tenancy
   ```

   Only the first line grants any power to destroy, and it stops at the
   `uk-transit` compartment. Everything else is read or attach-only.

   On the user page: API keys -> Add API key -> generate, download the private
   key, and copy the config preview it shows you.

3. **Add four repository secrets** (Settings -> Secrets and variables ->
   Actions). Paste each file's full contents:

   | Secret | From |
   |---|---|
   | `OCI_CONFIG` | the config preview for the `ci-hunter` user |
   | `OCI_API_KEY` | that user's API private key (`.pem`) |
   | `VM_SSH_KEY` | `~/.ssh/uktransit_vm` - matches the pubkey baked in at launch |
   | `APP_ENV` | `uk_transit_live/.env` |

4. **Add one repository variable** (same page, Variables tab):
   `OCI_COMPARTMENT_ID` = the OCID of the `uk-transit` compartment. Without it
   the hunt falls back to the tenancy root, which works but throws away the
   blast-radius limit. OCIDs are identifiers, not secrets, so a variable is
   the right home for it.

5. **Optional:** set a variable `DATA_PAYLOAD_URL` pointing at a tar.gz of the
   prebuilt `data/` caches (railnet.pkl and friends, ~99 MB - a GitHub Release
   asset works). Without it the app rebuilds them on first boot, which works
   but means a long Overpass crawl for the GB rail graph.

Workflow files cannot be pushed with a token that lacks the `workflow` scope.
SSH remotes have no such restriction:

```bash
git remote set-url origin git@github.com:btctree/uk-transit-live.git
```

### The compartment quota wall (Pay As You Go safety)

On a Free Tier account, asking for more than the Always Free allowance is
simply refused - the tier is a hard wall. On Pay As You Go the same request
succeeds and bills. Before upgrading, a compartment quota named
`uk-transit-free-tier-wall` was created in the root compartment so Oracle
itself enforces the ceiling:

```
zero compute-core quotas in compartment uk-transit
zero compute-memory quotas in compartment uk-transit
set compute-core quota standard-a1-core-count to 2 in compartment uk-transit
set compute-memory quota standard-a1-memory-count to 12 in compartment uk-transit
set compute-core quota standard-a1-core-regional-count to 2 in compartment uk-transit
set compute-memory quota standard-a1-memory-regional-count to 12 in compartment uk-transit
```

**The last two lines are not optional.** `zero compute-core quotas` also
zeroes the *regional* counts, and an A1 launch needs both the per-AD and the
regional quota. Omitting them looks correct - the per-AD quota reads 2 - while
every single launch fails with `HTTP 400 QuotaExceeded`. This cost one failed
scheduled run before it was spotted.

Verify with `get_resource_availability` on both `standard-a1-core-count` (per
AD) and `standard-a1-core-regional-count` (regional): both must be non-zero,
while a non-free shape such as `standard-e4-core-count` must read 0.

### Behaviour

- Deploys only when that run *launched* the instance, so a scheduled run can
  never redeploy over a working server. To retry a failed deploy, dispatch the
  workflow manually with `force_deploy: true`.
- `oci_hunt_once.py` refuses to launch a second instance if one already exists
  in RUNNING/PROVISIONING/STARTING - the guard against two hunters racing.
- Triggers are `schedule` and `workflow_dispatch` only. There is deliberately
  no `pull_request` trigger: on a public repo that would let a forked PR reach
  these secrets.
- Run logs are public. The scripts print HTTP status and error codes, never
  exception reprs, which can carry request headers.

## Alternatives considered
- GitHub Pages/Actions: static only / 6h job limit - not suitable.
- Render/Railway free tiers: sleep on idle, ephemeral disk (would re-download
  NaPTAN+GTFS on every wake), or trial credit that runs out.
- Fly.io: no longer meaningfully free.
