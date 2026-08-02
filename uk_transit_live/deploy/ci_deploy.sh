#!/bin/bash
# Deploy UK Transit Live to a fresh Ubuntu VM from a CI runner.
#
# push_to_vm.sh is the laptop version: it packages the local data/ caches,
# which a runner does not have (data/ is gitignored - 3.4 GB).  This version
# ships the repo contents plus, optionally, a prebuilt cache tarball fetched
# from a URL, and lets the app rebuild anything missing on first boot.
#
# Usage:  bash deploy/ci_deploy.sh <VM_PUBLIC_IP>
# Env:
#   SSH_KEY_FILE    private key matching the pubkey baked in at launch (required)
#   ENV_FILE        the app's .env to install (required)
#   DATA_PAYLOAD_URL  optional tar.gz of prebuilt data/ caches
set -euo pipefail

IP="${1:-}"
[ -z "$IP" ] && { echo "usage: bash deploy/ci_deploy.sh <VM_PUBLIC_IP>"; exit 1; }
: "${SSH_KEY_FILE:?SSH_KEY_FILE not set}"
: "${ENV_FILE:?ENV_FILE not set}"

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"      # .../uk_transit_live
SSH_OPTS=(-i "$SSH_KEY_FILE" -o StrictHostKeyChecking=accept-new
          -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
          -o ConnectTimeout=15)

echo "== waiting for ssh =="
for i in $(seq 1 40); do
  if ssh "${SSH_OPTS[@]}" -o BatchMode=yes ubuntu@"$IP" true 2>/dev/null; then
    echo "ssh up after ${i} tries"; break
  fi
  [ "$i" = 40 ] && { echo "ssh never came up"; exit 1; }
  sleep 15
done

echo "== packaging app =="
TAR=$(mktemp -d)/uktransit_payload.tar.gz
cp "$ENV_FILE" "$APP_DIR/.env"
tar -czf "$TAR" -C "$APP_DIR" \
    --exclude='__pycache__' --exclude='*.pyc' \
    server.py requirements.txt .env adapters static deploy
rm -f "$APP_DIR/.env"
ls -lh "$TAR"

echo "== copying to server =="
scp "${SSH_OPTS[@]}" "$TAR" ubuntu@"$IP":/tmp/uktransit_payload.tar.gz

echo "== server setup =="
ssh "${SSH_OPTS[@]}" ubuntu@"$IP" \
    "DATA_PAYLOAD_URL='${DATA_PAYLOAD_URL:-}' bash -s" <<'REMOTE'
set -euo pipefail
sudo mkdir -p /opt/uk-transit/uk_transit_live
sudo chown -R ubuntu:ubuntu /opt/uk-transit
tar -xzf /tmp/uktransit_payload.tar.gz -C /opt/uk-transit/uk_transit_live
cd /opt/uk-transit/uk_transit_live
chmod 600 .env

# Prebuilt caches are optional: without them the app rebuilds on first boot,
# which works but costs a long Overpass crawl for the GB rail graph.
if [ -n "${DATA_PAYLOAD_URL}" ]; then
  echo "-- fetching prebuilt data caches --"
  mkdir -p data
  curl -fsSL --retry 3 "${DATA_PAYLOAD_URL}" -o /tmp/data.tar.gz \
    && tar -xzf /tmp/data.tar.gz -C data \
    && echo "caches installed" \
    || echo "cache download failed - app will rebuild them itself"
fi

# A freshly-launched Ubuntu image is still running cloud-init, which holds the
# apt lock for the first minute or two. Arriving mid-boot means
# "Could not get lock /var/lib/apt/lists/lock" and a dead deploy - which is
# exactly what happens when the hunt wins and deploys seconds later.
echo "-- waiting for cloud-init to finish --"
sudo cloud-init status --wait 2>/dev/null || true
# Belt and braces: apt itself waits rather than failing fast if anything
# (unattended-upgrades) is still holding the lock.
APT_OPTS="-o DPkg::Lock::Timeout=300"
sudo apt-get $APT_OPTS update -qq
sudo apt-get $APT_OPTS install -y -qq python3-venv > /dev/null
python3 -m venv /opt/uk-transit/venv
/opt/uk-transit/venv/bin/pip install --quiet --upgrade pip
/opt/uk-transit/venv/bin/pip install --quiet -r requirements.txt

# Oracle's Ubuntu images firewall everything except 22 via iptables
for p in 80 443 8620; do
  sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || \
  sudo iptables -I INPUT -p tcp --dport $p -j ACCEPT
done
sudo DEBIAN_FRONTEND=noninteractive apt-get $APT_OPTS install -y -qq iptables-persistent > /dev/null 2>&1 || true
sudo netfilter-persistent save 2>/dev/null || true

sudo cp deploy/uk-transit.service /etc/systemd/system/uk-transit.service
sudo systemctl daemon-reload
sudo systemctl enable --now uk-transit
sleep 8
systemctl --no-pager --lines=0 status uk-transit | head -5
REMOTE

echo "== smoke test =="
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$IP:8620/" || true)
  echo "try $i: HTTP ${code:-none}"
  [ "$code" = "200" ] && { echo "serving"; exit 0; }
  sleep 10
done
echo "server did not return 200 within ~2 minutes"
exit 1
