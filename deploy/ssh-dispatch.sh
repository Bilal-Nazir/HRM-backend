#!/usr/bin/env bash
# Forced-command SSH entry point. This key cannot open a shell or forward ports.
set -euo pipefail
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ (backend|frontend)\ ([a-f0-9]{40})$ ]]; then
  exec sudo -n /opt/hrm/deploy-release.sh "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
fi
printf 'Only HRM release deployment is allowed.\n' >&2
exit 1
