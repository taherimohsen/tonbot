#!/bin/bash
set -e

DOMAIN=$1
EMAIL="bot@techtarfand.sbs"
REPO=$3

if [ -z "$DOMAIN" ] || [ -z "$REPO" ]; then
    echo "Usage: $0 <domain> <email> <repo>"
    exit 1
fi

apt update
apt install -y curl git ufw nginx certbot python3-certbot-nginx nodejs npm

ufw allow 80
ufw allow 443

# SSL
certbot certonly --standalone --agree-tos -m $EMAIL -d $DOMAIN --non-interactive

# Clone repo
rm -rf /root/tonbot
git clone $REPO /root/tonbot

# Install dependencies
cd /root/tonbot
npm install

# Setup systemd service
cat <<EOF >/etc/systemd/system/ton-webhook.service
[Unit]
Description=TON Webhook Bot
After=network.target

[Service]
ExecStart=/usr/bin/npm start
WorkingDirectory=/root/tonbot
Restart=always
User=root
Environment=NODE_ENV=production
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=ton-webhook

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ton-webhook
systemctl start ton-webhook

echo "Installation complete. Bot running with SSL on $DOMAIN"
