# GitHub → existing AWS server

## Current setup

Docker and Compose are installed on the existing AWS server. The `hrm-deploy`
account, Actions secrets, and separate IP-only Nginx host are configured.
The IP host has a trusted Let's Encrypt certificate and an automatic renewal timer.
The existing CustomerCore site remains enabled. Check both Actions runs and
the live health endpoint after pushing either repository.

## One-time activation checklist

1. Install Docker Engine plus Compose v2 on the server.
2. Generate a dedicated Ed25519 deployment key, and obtain the server host public
   key over the already trusted `ssh aws-dev` connection (do not blindly trust keyscan).
3. Copy `compose.aws.yaml`, `Caddyfile`, `mongo-init.js`, `deploy-release.sh`,
   `ssh-dispatch.sh`, `provision-aws.sh`, and the public deployment key named
   `deploy-key.pub` into a new root-owned `/opt/hrm` directory. Review and run
   `sudo bash /opt/hrm/provision-aws.sh`. This creates the dedicated account and
   root-only random secrets; it does not alter existing databases.
4. Set the four GitHub secrets listed below in **both** repositories. Never use
   your personal SSH private key for the pipeline.
5. Review `nginx.aws.conf`, install it as a separate Nginx site, run `nginx -t`,
   and reload Nginx only if validation succeeds. Keep existing sites enabled.
6. Commit/push the Docker files and workflow in each repository. Inspect both
   Actions runs and verify container health, login, and persistence before use.

Use the HTTPS address for login and browser location check-in.

Each repository has `.github/workflows/deploy.yml`. A push to `main` builds its
production image on a GitHub-hosted runner and streams the compressed image over
SSH to AWS. Manual runs are also available in the Actions tab. There is no paid
registry or on-server build step. GitHub/AWS account limits and charges still apply.

## Server layout

- `/opt/hrm/compose.aws.yaml`: independent `hrm` Compose project.
- `/opt/hrm/.env`: root-only generated database/JWT/bootstrap secrets.
- `/opt/hrm/images.env`: currently selected immutable Git SHA image tags.
- `/opt/hrm/deploy-release.sh`: locked deployments, health checks, previous-image rollback.
- `/opt/hrm/ssh-dispatch.sh`: restricted deployment-only SSH command.
- `hrm-deploy`: dedicated account, no general shell via its Actions key, no port forwarding.
- Host Nginx proxies the IP-only virtual host to `127.0.0.1:18080`.
- Existing CustomerCore Nginx host, MongoDB, Redis, Node, and Java services are not replaced.

Runtime memory caps total approximately 1.6 GiB. Monitor the shared server's RAM,
swap, disk, and container restarts; caps are not a guarantee of adequate capacity.
Database volumes are persistent but must be backed up separately.

## GitHub configuration (both repositories)

Encrypted Actions repository secrets:

| Secret | Purpose |
| --- | --- |
| `DEPLOY_HOST` | AWS public IP |
| `DEPLOY_USER` | `hrm-deploy` |
| `DEPLOY_SSH_KEY` | Dedicated deployment private key, not your personal SSH key |
| `DEPLOY_KNOWN_HOSTS` | Host key obtained over the existing trusted SSH connection |

Deploys only run on `main` pushes or explicit manual dispatch, never pull requests.
Anyone able to push deployment code to main effectively controls the deployed app;
limit repository write access and use branch protection where appropriate.

The first image waits until the other repository has deployed its first image.
Later pushes update only changed containers. A failed health check attempts to
restore previous image tags. This cannot undo data migrations. Updates can cause
brief downtime; this is a single-server deployment, not zero-downtime infrastructure.

## What updates automatically

Application/Dockerfile changes deploy on push. The root-owned server deployment
scripts, Compose configuration, and Nginx configuration do **not** automatically
overwrite themselves on push. Changes to infrastructure files require an explicit
reviewed server update through `ssh aws-dev`.

## Operations

```sh
ssh aws-dev
sudo docker compose --env-file /opt/hrm/.env --env-file /opt/hrm/images.env -f /opt/hrm/compose.aws.yaml ps
sudo docker compose --env-file /opt/hrm/.env --env-file /opt/hrm/images.env -f /opt/hrm/compose.aws.yaml logs --tail=100 backend
```

Use the root-only `.env` to retrieve the initial admin password privately on your
own terminal, then change it through the app. Never paste it in GitHub or chat.
New deployment creates an empty HRM database; local development data is not migrated.

Current requested address: `https://3.126.250.133/admin/login`. HTTP redirects to
HTTPS. Let's Encrypt IP certificates last about six days, so the
`hrm-cert-renew.timer` checks twice daily and reloads Nginx after renewal. Monitor
the timer and certificate expiration; public IP changes require a new certificate.
For a local tunnel, forward the private port through SSH and open localhost:

```sh
ssh -N -L 3001:127.0.0.1:18080 aws-dev
# Open http://localhost:3001/admin/login
```

Never run `down -v` or global Docker pruning commands on the shared host.
The deployment script removes only older `hrm-backend` / `hrm-frontend` tags,
keeping current and immediately previous images. For database backups use the
guide in `README.md`, with `/opt/hrm/.env`, `/opt/hrm/images.env`, and
`/opt/hrm/compose.aws.yaml` as the Compose arguments above.
