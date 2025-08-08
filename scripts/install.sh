#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-}"
REPO_URL="${2:-}"             # مثال: https://github.com/taherimohsen/tonbot.git
EMAIL="${3:-bot@${DOMAIN}}"

if [[ -z "$DOMAIN" || -z "$REPO_URL" ]]; then
  echo "Usage: $0 <DOMAIN> <REPO_URL> [EMAIL]"
  exit 1
fi

apt update && apt upgrade -y
apt install -y curl git ufw nginx certbot python3-certbot-nginx

# Node.js 18
apt remove -y nodejs npm || true
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs
node -v; npm -v

ufw allow 80 || true
ufw allow 443 || true

# اگر قبلاً کلون کردی، این دو خط لازم نیست
rm -rf /root/tonbot
git clone "${REPO_URL}" /root/tonbot

# Nginx
sed "s/__DOMAIN__/${DOMAIN}/g" /root/tonbot/nginx/ton-bot.conf.template > /etc/nginx/sites-available/tonbot.conf
ln -sf /etc/nginx/sites-available/tonbot.conf /etc/nginx/sites-enabled/tonbot.conf
nginx -t && systemctl reload nginx

# SSL
certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}"

# npm
cd /root/tonbot
npm install

# systemd
cp /root/tonbot/systemd/ton-webhook.service /etc/systemd/system/ton-webhook.service
systemctl daemon-reload
systemctl enable ton-webhook
systemctl restart ton-webhook

echo "DONE  →  https://${DOMAIN}/health"
systemctl status ton-webhook --no-pager || true
