# One-server Docker deployment

Runs Next.js, Node, MongoDB, Redis, and Caddy together. No paid managed database is
required. Docker does not supply a free cloud server: provision an eligible free
VM separately. Images support ARM64 and AMD64; validate on your chosen VM before
using real employee data. Free cloud capacity/continued availability is not guaranteed.

## Requirements

- Docker Engine with Docker Compose v2 installed on the server.
- Clone both repositories as siblings named `HRM-backend` and `HRM-frontend`.
- For public use, a hostname pointing to the VM and inbound TCP 80/443 allowed
  in both the cloud firewall and server firewall. Restrict SSH to your own IP.
- Do **not** open MongoDB 27017, Redis 6379, backend 8080, or frontend 3000.

## Configure and start

From `HRM-backend`:

```sh
cp .env.docker.example .env.docker
chmod 600 .env.docker
openssl rand -hex 32
```

Edit `.env.docker`, generating a **different** value for each secret. Use hex
database passwords to avoid URI escaping. All fields must be filled in. The
initial admin password must have at least 12 characters. Do not reuse development
credentials. Never commit this file or paste it into chat.

For a local smoke test leave `SITE_ADDRESS=http://localhost`. For a real server,
set `SITE_ADDRESS=hrm.your-domain.com` (without `http://`) after configuring DNS.
Caddy obtains HTTPS certificates automatically. Browser check-in location needs
HTTPS on public hosts; an HTTP server IP is not sufficient.

```sh
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 180
docker compose --env-file .env.docker ps
```

Open `/admin/login` and sign in with employee ID `admin-001` and your configured
initial password. Employees use `/login`. The API health URL is `/api/health`.
Change the admin password after first login. Bootstrap does not overwrite an
existing admin's password.

This starts a **new empty database**, not your local MongoDB. Existing employee
records are not migrated. Plan a separate authenticated backup/restore if needed.
The Mongo app user has access only to `hrm`; the root account is for maintenance.
Database credentials initialize only on a fresh volume. Editing environment
passwords later does not rotate existing Mongo users—rotate in MongoDB as well.

## Verify before real use

1. Check `/api/health` and all five containers in `compose ps`.
2. Log in as admin, create a test employee, and test employee login.
3. Check attendance with browser location permission over HTTPS.
4. Test leave submission/admin review and announcements.
5. Restart the stack and confirm records and login still work.

Containers restart after host reboot provided Docker itself starts at boot.
Only Caddy exposes host ports. Mongo/Redis use a private internal network and
named volumes; Redis append-only persistence is enabled. Application processes
run as non-root, and container logs rotate.

## Updates and logs

Pull both repos before rebuilding (run `git pull --ff-only` inside each repository).
Then run the same `up -d --build --wait` command. This is **manual deployment**;
GitHub auto-deploy is not configured yet and needs a reachable server and credentials.
Single-server updates may cause brief downtime.

```sh
docker compose --env-file .env.docker logs --tail=100 backend
docker compose --env-file .env.docker logs --tail=100 proxy
docker compose --env-file .env.docker stop
docker compose --env-file .env.docker start
```

Do not run `docker compose down -v`: it deletes the database and certificate
volumes. Normal `down` retains named volumes. Volumes are **not backups**.

## Database backup

Run from the backend folder; keep backups private, encrypted, and off-server.
This example uses the root credential already inside the database container,
not a plaintext password in your shell history:

```sh
mkdir -p backups
chmod 700 backups
umask 077
docker compose --env-file .env.docker exec -T mongo sh -c 'exec mongodump --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db hrm --archive --gzip' > "backups/hrm-$(date +%Y%m%d-%H%M%S).archive.gz"
```

Check the command succeeded before relying on the archive. Test restoring into a
separate database/stack before production use. Back up `.env.docker` securely
as well. A host loss can lose all services together; this setup is not HA.

## Current verification

Docker is not installed in the development environment used to prepare these
files. A real image build and container smoke test are still required. This
configuration does not imply a cloud deployment has been performed.
