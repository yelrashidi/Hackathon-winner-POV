# Run the demo with Docker

Everything (database, app, Gmail poller) runs from one command on any machine with Docker. You
need nothing else: no Node, no Postgres, no API keys. Checked on 2026-11-22 from a fresh clone of
`andrew-audit-db` with no `.env.local` (macOS arm64, Docker 29 via Colima).

## 1. Install Docker

- **macOS / Windows:** [Docker Desktop](https://www.docker.com/products/docker-desktop/), then start it.
- **Linux:** Docker Engine + the Compose plugin (`docker compose version` should print v2.x).

## 2. Get the code and start it

```bash
git clone https://github.com/yelrashidi/Hackathon-winner-POV.git
cd Hackathon-winner-POV
docker compose up -d
```

The first run builds the image (a few minutes) and creates the database. When the command
returns, open **http://localhost:3000**.

Behind that one command (`docker-compose.yml`):

| Service | What it does |
| --- | --- |
| `db` | Postgres 16. Two logins: `postgres` (owner, migrations + seed) and `ap_app` (the app), which cannot edit or backdate the audit trail. |
| `setup` | Runs once, then exits: applies migrations and, **only on an empty database**, builds the demo: 10 months of history (426 invoices) plus the 56 bills in the AP inbox run through intake (`scripts/docker-setup.ts`). |
| `app` | The website (frontend and backend), as `ap_app`. Starts after `setup` finishes. |
| `gmail-poller` | Reads new bills from the team's Gmail inbox. Without Gmail keys it prints `Gmail not configured … Poller not started.` and stops. That is expected; nothing else depends on it. |

Check that it worked:

```bash
docker compose ps              # db, app (and gmail-poller if configured) are Up; setup has Exited (0)
docker compose logs setup      # ends with: seeded { …, inboxBillsIngested: 56, … }
```

## 3. Use the demo

On http://localhost:3000, pick who you are. One person per role:

| Person | Role |
| --- | --- |
| Aiden Grant | Employee (read-only: Home + My bills) |
| Jordan Okafor | AP Clerk |
| Dev Malhotra | Department Manager (Operations) |
| Chloe Bergeron, Tomas Alvarez, Wen Zhao, Grace Mbeki, Liam O'Connor | Department Managers (Sales, Marketing, IT, People & Culture, Facilities; Liam is on leave) |
| Elise Tremblay | Finance Manager |
| Marcus Webb | Admin (Controller) |
| Priya Raman | CFO (releases what the Controller approved; approves over $250k) |
| Hannah Lindqvist | Auditor |

Switch person at any time with **Viewing as** (top right). The click-by-click walkthrough is
[`demo-script.md`](demo-script.md); screens per role are in
[`architecture/dashboard.md`](architecture/dashboard.md).

The one-click sign-in links (`/demo/as/U004?next=/checks`) only work in the no-Docker quick demo
(`npm run dev`). On Docker they return 404 on purpose; use the sign-in page instead.

**Your data stays** across restarts and rebuilds. To start over:

- In the app: sign in as **Marcus Webb** (Admin) → **Demo controls** → **Reset demo data**. Takes a few seconds.
- Or from the terminal: `docker compose down -v && docker compose up -d`.

## 4. Optional keys

Create `.env.local` next to `docker-compose.yml` (never commit it), then run `docker compose up -d`
again to apply it.

| Key | Without it |
| --- | --- |
| `ANTHROPIC_API_KEY` | Uploaded invoices open for manual entry instead of being read by Claude. The 56 inbox bills are already read, so the demo works fully without it. |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | No live email intake. Ask the team for the client ID and secret, then get the refresh token once on your machine with `npm install && npm run gmail:auth` (opens a browser; needs Node 22+). |

## Everyday commands

```bash
docker compose up -d --build           # after pulling new code: rebuild and restart
docker compose logs -f app             # app logs
docker compose logs -f gmail-poller    # watch email being read
docker compose stop                    # stop, keep the data
docker compose down -v                 # stop and delete the data (next `up` re-seeds)
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `port is already allocated` on **3000** | Run the app on another port: `APP_PORT=3001 docker compose up -d`, then open http://localhost:3001. |
| `port is already allocated` on **5432** | A local Postgres is already running. Stop it, or stop the other project's database container. |
| `error getting credentials … docker-credential-desktop: executable file not found` | Your `~/.docker/config.json` has `"credsStore": "desktop"` but Docker Desktop isn't installed (common with Colima). Delete that line and retry. |
| `Cannot connect to the Docker daemon` | Docker isn't running: start Docker Desktop (or `colima start`). |
| `setup` exited with an error | `docker compose logs setup` shows why. Start clean: `docker compose down -v && docker compose up -d`. |
| The page shows old screens after a `git pull` | The image is cached: `docker compose up -d --build`. |
| Signed in, but the next page says you are not | Fixed in BUG-Andrew-09. Pull, then `docker compose up -d --build`. |
| Dates look a day off | The containers use `America/Toronto`. Set another zone with `TZ=Europe/Paris docker compose up -d`. |

## Without Docker

`npm install && npm run dev` (Node 22+) builds a fresh in-memory demo on the first request. To keep
data between runs, use `npm run demo`. See the [README](../README.md#running-locally).
