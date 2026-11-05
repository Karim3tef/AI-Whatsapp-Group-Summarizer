#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu 22.04 / 24.04 server.
# Installs Node.js LTS, the libraries Chromium needs, pm2, and the project's
# dependencies. Run it as the bot user (with sudo rights), from the repo folder:
#
#   bash scripts/setup-server.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Updating package lists"
sudo apt-get update -y

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "==> Installing Node.js LTS"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "    Node $(node -v)"

echo "==> Installing Chromium libraries"
# Ubuntu 24.04 renamed libasound2 to libasound2t64.
if apt-cache show libasound2t64 >/dev/null 2>&1; then ASOUND=libasound2t64; else ASOUND=libasound2; fi
sudo apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
  libxshmfence1 libxfixes3 fonts-noto-core "$ASOUND"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> Installing pm2"
  sudo npm install -g pm2
fi

echo "==> Installing project dependencies"
npm ci --omit=dev

chmod 700 .

if [ ! -f .env ] && [ -t 0 ]; then
  echo "==> No .env yet, starting the setup wizard"
  npm run setup
fi
[ -f .env ] && chmod 600 .env

cat <<'EOF'

==> Done.
Next steps:
  1. npm run setup               # (if you skipped it) creates .env and your secrets
  2. npm start                   # scan the QR code, then try !جروبات and !تابع
  3. Ctrl+C, then:
       pm2 start ecosystem.config.js
       pm2 save
       pm2 startup               # run the sudo line it prints
EOF
