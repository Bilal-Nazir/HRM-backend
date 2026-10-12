#!/usr/bin/env bash
# Run once as root after copying deployment files to /opt/hrm.
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || exit 1
cd /opt/hrm
chmod 755 /opt/hrm
chown root:root deploy-release.sh ssh-dispatch.sh compose.aws.yaml Caddyfile mongo-init.js
chmod 755 deploy-release.sh ssh-dispatch.sh
chmod 644 compose.aws.yaml Caddyfile mongo-init.js
if ! id hrm-deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash hrm-deploy
fi
# Dedicated key only; account gets no Docker group membership or general sudo.
install -d -o hrm-deploy -g hrm-deploy -m 700 /home/hrm-deploy/.ssh
if [[ ! -f /home/hrm-deploy/.ssh/authorized_keys ]]; then
  install -o hrm-deploy -g hrm-deploy -m 600 /dev/null /home/hrm-deploy/.ssh/authorized_keys
fi
pubkey=$(< /opt/hrm/deploy-key.pub)
if ! grep -Fq "$pubkey" /home/hrm-deploy/.ssh/authorized_keys; then
  printf 'restrict,command="/opt/hrm/ssh-dispatch.sh" %s\n' "$pubkey" >> /home/hrm-deploy/.ssh/authorized_keys
fi
printf 'hrm-deploy ALL=(root) NOPASSWD: /opt/hrm/deploy-release.sh\n' > /etc/sudoers.d/hrm-deploy
chmod 440 /etc/sudoers.d/hrm-deploy
visudo -cf /etc/sudoers.d/hrm-deploy
if [[ ! -f .env ]]; then
  for name in MONGO_ROOT_PASSWORD MONGO_APP_PASSWORD REDIS_PASSWORD JWT_SECRET INITIAL_ADMIN_PASSWORD; do
    printf '%s=%s\n' "$name" "$(openssl rand -hex 32)" >> .env
  done
fi
chmod 600 .env
systemctl enable --now docker
printf 'Provisioned HRM deployment account and protected environment.\n'
