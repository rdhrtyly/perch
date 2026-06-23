# 🪺 Perch

My tiny self-hosted website deployer — like a little personal Vercel.

**Push code to GitHub → it builds → it goes live at its own web address with HTTPS.**

---

## How it works (the 5 little workers)

| Worker | Job | Tool |
|---|---|---|
| 📬 Mailman | Listens for "you pushed!" messages from GitHub | Node + Express |
| 🔒 Bouncer | Checks the secret so only *you* can deploy | Signed webhook |
| 🏗️ Builder | Clones your repo and builds it in a clean box | Docker |
| 🚪 Doorman | Gives each site a web address + free HTTPS | Caddy |
| 🖥️ Front Desk | The dashboard + live build-log page | HTML/CSS/JS |

**The flow:**

```
git push → GitHub webhook → Bouncer checks secret → Builder clones + builds
        → Doorman points yoursite.yourdomain at it (with HTTPS) → LIVE ✅
```

---

## What kinds of projects it deploys

Perch looks at your repo and figures out the type automatically:

- **Plain static site** (HTML/CSS/JS, no build) → served straight from disk.
- **React / Vite / Create React App** (has a `build` script) → built in Docker, then served as static files.
- **Next.js** (server-side) → built into a Docker image and run as a live app that Caddy forwards to.

You can override detection by putting a `perch.json` in your repo:

```json
{ "type": "static-build", "buildCommand": "npm run build", "outputDir": "dist" }
```

---

# 🚀 Setup — do these once

> 💡 **Heads up:** buying a domain and renting a server cost a little real
> money each year. Check with whoever pays the bills before you buy. 👍

You'll do things in this order:

1. Make the server (get its IP address)
2. Buy a domain (Porkbun)
3. Point the domain at the server (DNS)
4. Install Docker + Node on the server
5. Put Perch on the server and configure it
6. Start Caddy + Perch
7. Add your first site + set the GitHub webhook
8. Push and watch it deploy 🎉

---

## Step 1 — Make a server (Hetzner)

1. Go to **https://www.hetzner.com/cloud** and make an account.
2. Create a new **Cloud Server**:
   - **Image:** Ubuntu 24.04
   - **Type:** the cheapest shared-CPU one (e.g. CPX11) is plenty to start
   - **Location:** pick one near you
3. When it's made, copy its **IP address** (looks like `203.0.113.5`). You'll need it twice.

> You connect to the server with SSH. On Windows:
> open **PowerShell** and run `ssh root@YOUR_SERVER_IP`.

---

## Step 2 — Buy a domain (Porkbun)

We buy from **Porkbun** on purpose: it's cheap, and it's the exact
registrar Perch will automate in **Phase 2**, so nothing gets wasted.

1. Go to **https://porkbun.com** and make an account.
2. Search for a name you like. Tips:
   - A `.dev` always uses HTTPS (perfect — Caddy gives us HTTPS anyway).
   - `.com` / `.app` are classic. `.xyz` is often very cheap.
3. Buy it. (~$5–12/year for most.)
4. **Turn on free WHOIS privacy** when it offers — hides your info.

> Write your domain here so you don't forget: `________________`

---

## Step 3 — Point the domain at your server (DNS)

In Porkbun, open your domain → **DNS / DNS Records**. Add **two** records
so that your domain *and any subdomain* point to your server:

| Type | Host | Answer (value) |
|---|---|---|
| A | (leave blank, or `@`) | `YOUR_SERVER_IP` |
| A | `*` | `YOUR_SERVER_IP` |

The `*` (wildcard) is the magic part: it means **every** subdomain like
`forkful.yourdomain` and `collatz.yourdomain` automatically works — you
never touch DNS again when you add a new site. 🎉

> DNS can take a few minutes (sometimes longer) to start working.

---

## Step 4 — Install Docker + Node on the server

SSH into the server (`ssh root@YOUR_SERVER_IP`), then paste these:

```bash
# Update the system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh

# Install Node.js 20 + git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git

# Check they worked
docker --version && node --version && git --version
```

---

## Step 5 — Put Perch on the server

First, push this Perch folder to a GitHub repo of your own (e.g.
`yourname/perch`). Then on the server:

```bash
cd /opt
git clone https://github.com/YOURNAME/perch.git
cd perch
npm install

# Create your settings file from the example
cp .env.example .env
nano .env        # edit it (see below), then Ctrl+O, Enter, Ctrl+X to save
```

Fill in `.env`:

```
PORT=3000
WEBHOOK_SECRET=        # generate one — see next line
BASE_DOMAIN=useperch.dev
DASHBOARD_DOMAIN=useperch.dev
ACME_EMAIL=you@email.com
GITHUB_TOKEN=          # only for PRIVATE repos; leave blank otherwise
DATA_DIR=./data
```

Make a strong webhook secret and paste it into `WEBHOOK_SECRET`:

```bash
openssl rand -hex 32
```

> Keep that secret handy — you paste the **same** value into GitHub in Step 7.

---

## Step 6 — Start Caddy + Perch

```bash
# Start the Doorman (Caddy) — handles web addresses + HTTPS
docker compose up -d

# Start Perch itself (keep it running with pm2 so it survives reboots)
npm install -g pm2
pm2 start src/index.js --name perch
pm2 save
pm2 startup     # run the command it prints, to auto-start on reboot
```

Now visit **https://useperch.dev** — you should see your dashboard! 🎉
(The first load may take a few seconds while Caddy fetches the HTTPS padlock.)

---

## Step 7 — Add a site + connect GitHub

**On the dashboard:**
1. Click **+ Add site**.
2. Project name → e.g. `Forkful` (becomes `forkful.useperch.dev`).
3. GitHub repo → `yourname/forkful`.
4. Click **Add site**.

**On GitHub (the repo you just added):**
1. Repo → **Settings → Webhooks → Add webhook**.
2. **Payload URL:** `https://useperch.dev/webhook`
3. **Content type:** `application/json`
4. **Secret:** paste the **same** `WEBHOOK_SECRET` from your `.env`.
5. **Events:** "Just the push event."
6. Save.

> Do this webhook step once per repo you want Perch to deploy.

---

## Step 8 — Deploy! 🎉

Either **push any commit** to that repo, or click **Redeploy** on the
dashboard. You'll be taken to the **live log page** where you can watch
the build happen line-by-line. When it turns **Live**, click **Open ↗**.

---

## Trying it on your own computer first (optional)

You can run just the dashboard locally on Windows to see how it looks
(the actual building needs the Linux server with Docker):

```bash
npm install
npm start
# open http://localhost:3000
```

---

## 🔮 Phase 2 (later) — buy domains from the dashboard

Everything's already prepped for this:
- Your Porkbun keys go in `.env` (`PORKBUN_API_KEY`, `PORKBUN_SECRET_KEY`).
- The code lives in `src/domains/porkbun.js` (3 functions to fill in).
- The "add a site" flow already records where a domain came from.

So Phase 2 is *adding* a feature — not rewriting Phase 1.

---

## Folder map

```
perch/
├─ src/
│  ├─ index.js          the server (webhook + API + dashboard)
│  ├─ config.js         ⭐ all settings/secrets, in one place
│  ├─ webhook.js        the Bouncer (checks the secret)
│  ├─ deployer/         clone → detect → build → publish → Caddy
│  ├─ store/            your list of sites (JSON for now)
│  ├─ logs/             live build-log streaming
│  └─ domains/porkbun.js   🔮 Phase 2 goes here
├─ public/              the dashboard + live log page
├─ docker-compose.yml   runs Caddy
└─ .env                 your secrets (never committed)
```
