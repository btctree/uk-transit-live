#!/bin/bash
# One-time setup on an Ubuntu server (e.g. Oracle Cloud always-free VM).
# Usage: clone the repo to /opt/uk-transit first, then: sudo bash deploy/setup_server.sh
set -e
apt-get update && apt-get install -y python3-pip
pip3 install -r /opt/uk-transit/uk_transit_live/requirements.txt
# .env with your free API keys (copy from your PC - NEVER commit it):
#   /opt/uk-transit/uk_transit_live/.env
cp /opt/uk-transit/uk_transit_live/deploy/uk-transit.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now uk-transit
echo "Done. App at http://<server-ip>:8620  (open port 8620 in the Oracle security list)"
