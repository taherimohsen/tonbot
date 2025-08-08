#!/bin/bash
DOMAIN=$1
EMAIL=$2
REPO=$3

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ] || [ -z "$REPO" ]; then
    echo "Usage: $0 <domain> <email> <repo>"
    exit 1
fi

apt update && apt install -y nginx certbot python3-certbot-nginx git curl nodejs npm ufw

ufw allow 80
ufw allow 443

# Clone repo
rm -rf /root/tonbot
git clone $REPO /root/tonbot

# Nginx config
cp /root/tonbot/nginx/ton-bot.conf.template /etc/nginx/sites-available/tonbot.conf
sed -i "s/__DOMAIN__/$DOMAIN/g" /etc/nginx/sites-available/tonbot.conf
ln -sf /etc/nginx/sites-available/tonbot.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# SSL with email pre-set
certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL

# Node.js dependencies
npm install --prefix /root/tonbot

# Systemd service
cp /root/tonbot/systemd/ton-webhook.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ton-webhook
systemctl start ton-webhook

echo "✅ Installation complete: https://$DOMAIN"
