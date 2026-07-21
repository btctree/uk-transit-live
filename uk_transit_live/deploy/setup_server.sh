#!/bin/bash
# One-time setup on an Ubuntu 24.04 server (e.g. Oracle Cloud always-free VM).
# Copy the app to /opt/uk-transit/uk_transit_live first (see push_to_vm.sh),
# then: sudo bash deploy/setup_server.sh
set -e
apt-get update && apt-get install -y python3-venv
python3 -m venv /opt/uk-transit/venv
/opt/uk-transit/venv/bin/pip install -r /opt/uk-transit/uk_transit_live/requirements.txt
# .env with your free API keys (copy from your PC - NEVER commit it):
#   /opt/uk-transit/uk_transit_live/.env
# Oracle Ubuntu images firewall everything except 22 via iptables:
for p in 80 443 8620; do
  iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || \
  iptables -I INPUT -p tcp --dport $p -j ACCEPT
done
netfilter-persistent save 2>/dev/null || true
cp /opt/uk-transit/uk_transit_live/deploy/uk-transit.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now uk-transit
echo "Done. App at http://<server-ip>:8620  (also open 8620 in the Oracle security list)"
