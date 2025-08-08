#!/bin/bash
# install script placeholder
#!/bin/bash
DOMAIN=$1
EMAIL=$2
REPO=$3

apt update && apt install -y nginx certbot python3-certbot-nginx git curl nodejs npm
git clone $REPO /root/tonbot
cp /root/tonbot/nginx/ton-bot.conf.template /etc/nginx/sites-available/tonbot.conf
sed -i "s/__DOMAIN__/$DOMAIN/g" /etc/nginx/sites-available/tonbot.conf
ln -s /etc/nginx/sites-available/tonbot.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL
npm install --prefix /root/tonbot
cp /root/tonbot/systemd/ton-webhook.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ton-webhook
systemctl start ton-webhook
