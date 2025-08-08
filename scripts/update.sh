#!/usr/bin/env bash
set -euo pipefail
cd /root/tonbot
git pull --rebase
npm install
systemctl restart ton-webhook
systemctl status ton-webhook --no-pager || true
