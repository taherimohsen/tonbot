#!/bin/bash
cd /root/tonbot
git pull
npm install
systemctl restart ton-webhook
