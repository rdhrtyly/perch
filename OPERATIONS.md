# Perch — Production Readiness Runbook

Goal: get Perch reliable enough to trust a **real, money-making business
site** on it (e.g. a roofing company taking bookings). This file is the
checklist. Work top to bottom.

Server: `206.189.181.166` · dashboard: `https://useperch.dev`

---

## What changed in code (the `reliability-upgrades` branch)

These are already written and committed — they just need to be **deployed
and tested** (see step 1).

1. **Zero-downtime Next.js deploys + auto-rollback** (`src/deployer/docker.js`)
   - The new version starts on a side port and must **pass a health check**
     before traffic switches to it.
   - If the new build is broken, **the previous version stays live** — a bad
     deploy can no longer take a site down.
   - Note: a failed deploy shows status `failed` in the dashboard even though
     the previous version is still serving. That's expected — it means "last
     attempt failed, old version still up."

2. **Build memory cap** (`src/deployer/docker.js`, `src/config.js`)
   - A build can use at most `BUILD_MEMORY_MB` (default 1536) of RAM, so one
     heavy build can't OOM-kill the whole box. This is the main fix for the
     "memory thing." **Pair it with the swap file in step 2.**

3. **Health endpoint** (`src/index.js`) — `GET /_perch/health` returns `200`.
   Used by UptimeRobot / Cloudflare in steps 3–4.

---

## 1. Deploy + test the code changes  (do WITH supervision)

On the droplet:

```bash
ssh root@206.189.181.166
cd /path/to/perch
git fetch && git checkout reliability-upgrades   # or merge into main first
npm install
# restart however Perch runs (systemd? pm2? screen?) e.g.:
systemctl restart perch   # <-- adjust to how it actually runs
curl -s localhost:3000/_perch/health             # expect {"ok":true,...}
```

**Test the zero-downtime path before trusting it on a real site:**
- Deploy a **throwaway Next.js test site** through the dashboard.
- Redeploy it — confirm it stays reachable the whole time (no downtime).
- Push a **deliberately broken** version (e.g. a build error) — confirm the
  deploy is marked failed AND the previous version is **still live**.

Only after that passes should the roofing site go anywhere near Perch.

---

## 2. Harden the droplet  (one-time, ~2 min)

```bash
cd /path/to/perch && sudo bash scripts/harden.sh
```

Adds: 2 GB **swap** (kills the build-OOM problem), a **firewall** (only
22/80/443 open), **fail2ban**, **automatic security updates**, and a weekly
Docker cleanup. Safe to re-run.

---

## 3. Uptime monitoring  (free, ~5 min) — needs YOUR signup

So you find out it's down before a customer does.

1. Make a free account at **uptimerobot.com** (or betterstack.com).
2. Add an HTTP monitor:
   - URL: `https://useperch.dev/_perch/health`
   - Interval: 1 minute
   - Alerts: your email + phone/SMS.
3. Add one monitor per **real customer site** too (e.g. the roofing domain),
   not just the dashboard.

---

## 4. Cloudflare in front  (free, ~15 min) — needs YOUR signup

Free global CDN + DDoS protection + can serve a cached page even if the
droplet hiccups. Biggest single resilience win.

1. Make a free account at **cloudflare.com**, add your domain.
2. Cloudflare gives you 2 nameservers — set them at your registrar
   (Porkbun/Namecheap). DNS now runs through Cloudflare.
3. In Cloudflare DNS, point the domain (A record) at `206.189.181.166`,
   proxy **ON** (orange cloud).
4. SSL/TLS mode: **Full** (Caddy already serves HTTPS on the droplet).
5. Optional but nice: turn on "Always Online" so a cached copy shows if the
   origin is ever down.

> If you put Cloudflare in front, you can keep Caddy's HTTPS as-is (Full
> mode). Don't use "Flexible" — it can cause redirect loops.

---

## 5. Backups  (~3 min) — needs YOUR DigitalOcean dashboard

1. DigitalOcean → your droplet → **Backups** → enable (weekly, ~20% of
   droplet cost). One-click restore if the box ever dies.
2. Belt-and-suspenders for the data that matters (sites + accounts):
   ```bash
   # quick off-box copy of Perch's data dir
   tar czf perch-data-$(date +%F).tgz -C /path/to/perch data
   # then scp it somewhere off the droplet, or to object storage.
   ```
   Worth turning into a weekly cron later.

---

## 6. Buying + connecting a customer domain (e.g. KNJ Roofing)

1. Buy the domain at **Porkbun** (~$10–15/yr).
2. Easiest path: add it to **Cloudflare** (step 4) and point it at
   `206.189.181.166`. Caddy auto-issues HTTPS; the site is live on it.
3. In Perch, set the site's **custom domain** to the bought domain — Perch
   writes it into the Caddyfile and Caddy gets the certificate automatically.

---

## 7. "Is it ready for real money?" — final gate

Don't move a revenue site onto Perch until ALL of these are true:

- [ ] Code changes deployed + zero-downtime/rollback **tested** (step 1)
- [ ] `harden.sh` run; swap is active (`free -h` shows Swap > 0)
- [ ] UptimeRobot pinging the health endpoint + the customer domain
- [ ] Cloudflare in front (CDN + DDoS)
- [ ] DigitalOcean backups ON + a manual data backup taken once
- [ ] **Soak test:** Perch has run your existing sites for **4–6 weeks** with
      monitoring green and zero incidents.

Until the soak passes, launch the roofing site on **Vercel** and migrate it
to Perch once the box has earned the trust. The domain moves over in minutes.
