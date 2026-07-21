#!/bin/bash
# Push UK Transit Live to a fresh Ubuntu VM and start it under systemd.
# Run from Git Bash on the laptop:  bash deploy/push_to_vm.sh <VM_PUBLIC_IP>
# Uses ~/.ssh/uktransit_vm (the key baked into the instance at launch).
set -e
IP="$1"
[ -z "$IP" ] && { echo "usage: bash deploy/push_to_vm.sh <VM_PUBLIC_IP>"; exit 1; }
KEY=~/.ssh/uktransit_vm
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new ubuntu@$IP"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # .../uk_transit_live

echo "== packaging (app + small caches, no GTFS sqlites) =="
TAR=/tmp/uktransit_payload.tar.gz
tar -czf "$TAR" -C "$APP_DIR" \
    --exclude='data/gtfs_*.sqlite*' \
    --exclude='__pycache__' --exclude='*.pyc' \
    server.py requirements.txt .env adapters static deploy \
    data/railnet.pkl data/railpaths data/railnet_tiles \
    data/stops_gb.json data/rail_stations.json \
    $(cd "$APP_DIR" && ls data/geom_*.json)
ls -lh "$TAR"

echo "== copying to $IP =="
scp -i "$KEY" -o StrictHostKeyChecking=accept-new "$TAR" ubuntu@"$IP":/tmp/

echo "== server setup =="
$SSH 'bash -s' <<'REMOTE'
set -e
sudo mkdir -p /opt/uk-transit/uk_transit_live
sudo chown -R ubuntu:ubuntu /opt/uk-transit
tar -xzf /tmp/uktransit_payload.tar.gz -C /opt/uk-transit/uk_transit_live
cd /opt/uk-transit/uk_transit_live

sudo apt-get update -qq
sudo apt-get install -y -qq python3-venv > /dev/null
python3 -m venv /opt/uk-transit/venv
/opt/uk-transit/venv/bin/pip install --quiet --upgrade pip
/opt/uk-transit/venv/bin/pip install --quiet -r requirements.txt

# Oracle Ubuntu images firewall everything except 22 via iptables — open our ports
for p in 80 443 8620; do
  sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || \
  sudo iptables -I INPUT -p tcp --dport $p -j ACCEPT
done
sudo netfilter-persistent save 2>/dev/null || sudo apt-get install -y -qq iptables-persistent > /dev/null || true
sudo netfilter-persistent save 2>/dev/null || true

sudo tee /etc/systemd/system/uk-transit.service > /dev/null <<'UNIT'
[Unit]
Description=UK Transit Live server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/uk-transit/uk_transit_live
ExecStart=/opt/uk-transit/venv/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8620
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now uk-transit
sleep 5
systemctl --no-pager status uk-transit | head -8
REMOTE

echo "== smoke test =="
sleep 5
curl -s -o /dev/null -w "http://$IP:8620 -> HTTP %{http_code}\n" "http://$IP:8620/" || true
echo "done."
