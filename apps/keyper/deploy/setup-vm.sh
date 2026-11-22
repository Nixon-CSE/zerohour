#!/usr/bin/env bash
# Prepare an Ubuntu VM (tested target: Oracle Cloud Always Free, Ubuntu 24.04) to run Hourglass keypers.
#   sudo bash setup-vm.sh            install / update the code and the systemd unit
# Secrets are NOT handled here: put KEYPER_MNEMONIC and KEYPER_CHAIN_SECRET in /etc/zerohour/keyper-<n>.env
# (root-owned, 0600), then: sudo systemctl enable --now zerohour-keyper@<n>
set -euo pipefail
REPO="${REPO:-https://github.com/Nixon-CSE/zerohour.git}"
BRANCH="${BRANCH:-main}"

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

# 1. Swap: the 1 GB micro shape needs it for npm installs.
if [ ! -f /swapfile ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2. Node 20 (same major as development) and git.
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1)" != "v20" ]; then
  apt-get update -qq && apt-get install -y -qq ca-certificates curl gnupg git
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
command -v git >/dev/null || apt-get install -y -qq git

# 3. A dedicated, login-less user; the code is root-owned and read-only to it.
id zerohour >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin zerohour
install -d -m 0700 -o root -g root /etc/zerohour

# 4. Code: the public repository, the crypto library first (the keyper depends on it by path).
if [ -d /opt/zerohour/.git ]; then git -C /opt/zerohour fetch -q origin "$BRANCH" && git -C /opt/zerohour reset -q --hard "origin/$BRANCH"
else git clone -q --branch "$BRANCH" "$REPO" /opt/zerohour; fi
(cd /opt/zerohour/packages/hourglass && npm ci --no-audit --no-fund --loglevel=error)
(cd /opt/zerohour/apps/keyper && npm ci --include=dev --no-audit --no-fund --loglevel=error)

# 5. The unit, then restart whichever keypers are already enabled so they run the new code.
install -m 0644 /opt/zerohour/apps/keyper/deploy/zerohour-keyper@.service /etc/systemd/system/
systemctl daemon-reload
for u in $(systemctl list-units --plain --no-legend 'zerohour-keyper@*' | awk '{print $1}'); do systemctl restart "$u"; done
echo "code at $(git -C /opt/zerohour rev-parse --short HEAD); node $(node -v)"
