#!/usr/bin/env bash
# Installed root-owned. Reads a gzip Docker image stream from GitHub Actions.
set -euo pipefail
umask 077
component=${1:-}
sha=${2:-}
[[ $component =~ ^(backend|frontend)$ && $sha =~ ^[a-f0-9]{40}$ ]] || exit 2
cd /opt/hrm
exec 9>/opt/hrm/deploy.lock
flock -w 900 9

gzip -dc | docker load
docker image inspect "hrm-$component:$sha" >/dev/null
BACKEND_SHA=
FRONTEND_SHA=
if [[ -f images.env ]]; then source images.env; fi
old_backend=$BACKEND_SHA
old_frontend=$FRONTEND_SHA
if [[ $component == backend ]]; then BACKEND_SHA=$sha; else FRONTEND_SHA=$sha; fi
write_images() {
  printf 'BACKEND_SHA=%s\nFRONTEND_SHA=%s\n' "$BACKEND_SHA" "$FRONTEND_SHA" > images.env.next
  mv images.env.next images.env
}
write_images
if [[ -z $BACKEND_SHA || -z $FRONTEND_SHA ]]; then
  printf 'Image received; waiting for the other repository initial deployment.\n'
  exit 0
fi
compose=(docker compose --env-file .env --env-file images.env -f compose.aws.yaml)
"${compose[@]}" config --quiet
if "${compose[@]}" up -d --wait --wait-timeout 240 &&
   curl --fail --silent --retry 5 --retry-delay 3 --retry-connrefused http://127.0.0.1:18080/api/health >/dev/null &&
   curl --fail --silent http://127.0.0.1:18080/login >/dev/null; then
  printf 'HRM %s deployed successfully: %s\n' "$component" "$sha"
  "${compose[@]}" ps
  # Keep current + immediately previous application images; never prune other apps.
  for app in backend frontend; do
    current=$BACKEND_SHA; previous=$old_backend
    if [[ $app == frontend ]]; then current=$FRONTEND_SHA; previous=$old_frontend; fi
    while read -r tag; do
      if [[ $tag =~ ^[a-f0-9]{40}$ && $tag != "$current" && $tag != "$previous" ]]; then
        docker image rm "hrm-$app:$tag" || true
      fi
    done < <(docker image ls "hrm-$app" --format '{{.Tag}}')
  done
else
  printf 'Release failed health checks.\n' >&2
  if [[ -n $old_backend && -n $old_frontend ]]; then
    BACKEND_SHA=$old_backend; FRONTEND_SHA=$old_frontend
    write_images
    "${compose[@]}" up -d --wait --wait-timeout 240
    printf 'Restored previous application images; database changes are not rolled back.\n' >&2
  fi
  exit 1
fi
