#!/usr/bin/env bash
# 把 cedric-wake 装成 systemd 常驻服务（需要 root）
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"

[ -n "$NODE" ] || { echo "找不到 node，先装 Node 20.6 以上"; exit 1; }
[ -f "$DIR/.env" ] || { echo "没有 .env：先 cp .env.example .env 并填好"; exit 1; }
[ -f "$DIR/persona.md" ] || echo "提示：没有 persona.md，会先用 persona.example.md"

chmod 600 "$DIR/.env"
mkdir -p "$DIR/data"

cat > /etc/systemd/system/cedric-wake.service <<EOF
[Unit]
Description=cedric-wake
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
ExecStart=$NODE $DIR/index.mjs
Restart=always
RestartSec=30
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now cedric-wake
systemctl --no-pager status cedric-wake | head -n 5 || true
echo "看日志：journalctl -u cedric-wake -f"
