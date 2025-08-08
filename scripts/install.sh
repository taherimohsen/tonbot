#!/bin/bash

DOMAIN=$1
EMAIL=${2:-bot@$DOMAIN}
REPO=$3

if [ -z "$DOMAIN" ] || [ -z "$REPO" ]; then
  echo "Usage: $0 <domain> [email] <repo_url>"
  exit 1
fi

echo "📦 Updating packages..."
apt update && apt upgrade -y

echo "📦 Installing dependencies..."
apt install -y nginx certbot python3-certbot-nginx git curl

echo "📦 Installing Node.js 18..."
apt remove -y nodejs npm
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

echo "🔍 Node version:"
node -v
npm -v

echo "📂 Cloning repository..."
rm -rf /root/tonbot
git clone $REPO /root/tonbot

echo "⚙️ Configuring Nginx..."
cp /root/tonbot/nginx/ton-bot.conf.template /etc/nginx/sites-available/tonbot.conf
sed -i "s/__DOMAIN__/$DOMAIN/g" /etc/nginx/sites-available/tonbot.conf
ln -sf /etc/nginx/sites-available/tonbot.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

echo "🔐 Setting up SSL certificate..."
certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL

echo "📦 Installing Node.js packages..."
npm install --prefix /root/tonbot

echo "⚙️ Setting up systemd service..."
cp /root/tonbot/systemd/ton-webhook.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ton-webhook
systemctl restart ton-webhook

echo "✅ Installation complete: https://$DOMAIN"
systemctl status ton-webhook --no-pager
