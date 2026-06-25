#!/usr/bin/env bash
#
# harden.sh — run this ONCE on the Perch droplet (as root) to make it
# production-ready: swap (so builds stop crashing the box), a firewall,
# brute-force protection, automatic security updates, and a weekly cleanup.
#
#   ssh root@YOUR_DROPLET_IP
#   cd /path/to/perch && bash scripts/harden.sh
#
# It's safe to run more than once — it skips anything already done.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root:  sudo bash scripts/harden.sh"
  exit 1
fi

echo "==> 1/6  Swap file (fixes builds running out of memory)"
if swapon --show | grep -q '/swapfile'; then
  echo "    swap already on — skipping."
else
  # 2 GB swap. Bump to 4G on a bigger droplet if you like.
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "    2 GB swap created and enabled."
fi
# Prefer RAM, only lean on swap when needed.
sysctl -w vm.swappiness=10 >/dev/null
grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

echo "==> 2/6  Firewall (allow SSH + web only)"
if command -v ufw >/dev/null; then
  ufw allow OpenSSH    >/dev/null || true
  ufw allow 80/tcp     >/dev/null
  ufw allow 443/tcp    >/dev/null
  ufw --force enable   >/dev/null
  echo "    ufw enabled: 22, 80, 443 open; everything else closed."
else
  echo "    ufw not installed — installing..."
  apt-get update -qq && apt-get install -y -qq ufw
  ufw allow OpenSSH >/dev/null || true
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

echo "==> 3/6  fail2ban (blocks SSH brute-force)"
if ! command -v fail2ban-server >/dev/null; then
  apt-get update -qq && apt-get install -y -qq fail2ban
fi
systemctl enable --now fail2ban >/dev/null 2>&1 || true
echo "    fail2ban active."

echo "==> 4/6  Automatic security updates"
apt-get install -y -qq unattended-upgrades >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
echo "    security patches will install themselves."

echo "==> 5/6  Weekly Docker cleanup (stops disk filling with old images)"
cat > /etc/cron.weekly/perch-docker-prune <<'CRON'
#!/bin/sh
docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true
docker builder prune -af >/dev/null 2>&1 || true
CRON
chmod +x /etc/cron.weekly/perch-docker-prune
echo "    weekly prune scheduled."

echo "==> 6/6  Done."
echo
echo "Summary:"
free -h | awk 'NR==1||/Swap/'
echo
ufw status | head -n 5
echo
echo "Next: set up monitoring + backups + Cloudflare — see OPERATIONS.md."
