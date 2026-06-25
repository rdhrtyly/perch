// docker.js — runs the actual building inside Docker, streaming every
// line of output to the live log. Docker gives each build a clean,
// identical box — which is exactly what lets Perch scale to many sites
// (and, later, many servers) without surprises.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const logs = require('../logs/stream');
const config = require('../config');
const store = require('../store');
const caddy = require('./caddy');

// Run any command and send its output to the deploy log, live.
function run(deployId, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    logs.log(deployId, `$ ${command} ${args.join(' ')}`);
    const child = spawn(command, args, options);

    const pipe = (buf) =>
      buf
        .toString()
        .split('\n')
        .forEach((l) => l && logs.log(deployId, l));

    child.stdout.on('data', pipe);
    child.stderr.on('data', pipe);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`command failed (exit ${code})`));
    });
  });
}

// Turn a site's { KEY: value } env into docker "-e KEY=value" flags.
function envFlags(env) {
  const flags = [];
  for (const [k, v] of Object.entries(env || {})) flags.push('-e', `${k}=${v}`);
  return flags;
}

// Memory caps for a build container. A heavy build (npm ci + framework
// build) can otherwise eat all the server's RAM and let Linux kill random
// processes — taking OTHER people's live sites down with it. With a cap,
// at worst THIS one build fails; everything already running stays up.
function buildMemoryFlags() {
  return [
    '--memory', `${config.buildMemoryMb}m`,
    '--memory-swap', `${config.buildMemoryMb * 2}m`, // allow some swap on top of RAM
  ];
}

// Build a static / React project inside a clean Node container.
// Returns the folder that holds the finished files.
async function buildStatic(deployId, repoDir, plan, env) {
  // Install dependencies, then run the build — all inside node:20-alpine
  // (a small, fast Linux image with Node already on it).
  const install = 'if [ -f package-lock.json ]; then npm ci; else npm install; fi';
  const script = `${install} && ${plan.buildCommand}`;

  // Cap Node's heap a little under the container limit so the build fails
  // cleanly instead of being OOM-killed mid-write.
  const nodeOpts = { NODE_OPTIONS: `--max-old-space-size=${Math.floor(config.buildMemoryMb * 0.75)}` };

  await run(deployId, 'docker', [
    'run', '--rm',
    ...buildMemoryFlags(),
    ...envFlags({ ...nodeOpts, ...env }), // site env wins if it sets NODE_OPTIONS itself
    '-v', `${repoDir}:/app`,
    '-w', '/app',
    'node:20-alpine',
    'sh', '-c', script,
  ]);

  return path.join(repoDir, plan.outputDir || 'dist');
}

// Build AND run a Next.js app (it needs a live server, not just files).
//
// Zero-downtime: we build the new image, start it on a set-aside port,
// and only switch the public web address over once it proves it's healthy.
// If the new version is broken, the previous one keeps serving — a bad
// deploy never takes the site down.
async function buildAndRunNext(deployId, repoDir, site) {
  const image = `perch-${site.id}:latest`;

  // If the repo doesn't include its own Dockerfile, drop in a standard one.
  const dockerfile = path.join(repoDir, 'Dockerfile');
  if (!fs.existsSync(dockerfile)) {
    fs.writeFileSync(dockerfile, defaultNextDockerfile());
    logs.log(deployId, "No Dockerfile found — using Perch's default Next.js one.");
  }

  await run(deployId, 'docker', ['build', ...buildMemoryFlags(), '-t', image, repoDir]);

  // Start the NEW version alongside the old one, on a fresh private port.
  const oldContainer = site.container || `perch-${site.id}`;
  const newPort = freePort(site.port);
  const newContainer = `perch-${site.id}-${Date.now()}`;

  logs.log(deployId, `Starting the new version on port ${newPort} (the live one keeps serving)...`);
  await run(deployId, 'docker', [
    'run', '-d',
    '--name', newContainer,
    '--restart', 'unless-stopped',
    ...envFlags(site.env),          // the site's secret settings, at runtime
    '-p', `127.0.0.1:${newPort}:3000`,
    image,
  ]);

  // Health gate: wait until the new app actually answers before we trust it.
  logs.log(deployId, 'Waiting for the new version to pass its health check...');
  const healthy = await waitForHealthy(newPort, config.healthTimeoutMs);
  if (!healthy) {
    logs.log(deployId, 'New version FAILED its health check — rolling back. The previous version is still live.');
    await run(deployId, 'docker', ['rm', '-f', newContainer]).catch(() => {});
    throw new Error('new version failed its health check — kept the previous version live');
  }

  // It's good. Point Caddy at the new port, THEN retire the old container.
  logs.log(deployId, 'New version is healthy — switching traffic over with no downtime...');
  store.updateSite(site.id, { port: newPort, container: newContainer });
  await caddy.writeAndReload();

  if (oldContainer !== newContainer) {
    await run(deployId, 'docker', ['rm', '-f', oldContainer]).catch(() => {});
  }
  logs.log(deployId, 'Switched over; retired the previous version.');
}

// Pick a private port not already used by another site (and not the port
// the current live container is on, so old + new can run side by side).
function freePort(avoid) {
  const used = new Set(store.listSites().map((s) => s.port).filter(Boolean));
  if (avoid) used.add(avoid);
  let p = 4001;
  while (used.has(p)) p++;
  return p;
}

// Poll a local port until the app answers. Any HTTP reply under 500 means
// it booted and is serving. Gives a fresh container time to start up.
function waitForHealthy(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 45000);
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 4000 }, (res) => {
        res.resume(); // drain
        if (res.statusCode < 500) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(attempt, 1500);
    };
    attempt();
  });
}

function defaultNextDockerfile() {
  return `# Auto-generated by Perch for Next.js apps.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
`;
}

module.exports = { run, buildStatic, buildAndRunNext };
