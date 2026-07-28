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

1. **Create a restricted OCI user for CI.** Do not use your admin API key: the
   same tenancy holds your other VMs, and a leaked admin key can terminate
   them. Give the CI user a policy no wider than:

   ```
   Allow group ci-hunters to manage instance-family in compartment <name>
   Allow group ci-hunters to read app-catalog-listing in tenancy
   Allow group ci-hunters to use subnet in compartment <name>
   Allow group ci-hunters to use network-security-groups in compartment <name>
   Allow group ci-hunters to use vnics in compartment <name>
   Allow group ci-hunters to inspect availability-domains in tenancy
   ```

2. **Add four repository secrets** (Settings -> Secrets and variables ->
   Actions). Paste each file's full contents:

   | Secret | From |
   |---|---|
   | `OCI_CONFIG` | `~/.oci/config` for the CI user |
   | `OCI_API_KEY` | that user's API private key (`.pem`) |
   | `VM_SSH_KEY` | `~/.ssh/uktransit_vm` - matches the pubkey baked in at launch |
   | `APP_ENV` | `uk_transit_live/.env` |

3. **Optional:** set a repository *variable* `DATA_PAYLOAD_URL` pointing at a
   tar.gz of the prebuilt `data/` caches (railnet.pkl and friends, ~99 MB -
   a GitHub Release asset works). Without it the app rebuilds them on first
   boot, which works but means a long Overpass crawl for the GB rail graph.

Workflow files cannot be pushed with a token that lacks the `workflow` scope.
SSH remotes have no such restriction:

```bash
git remote set-url origin git@github.com:btctree/uk-transit-live.git
```

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
