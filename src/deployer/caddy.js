// caddy.js — the "Doorman".
// Writes Caddy's config from your list of sites, then asks Caddy to
// reload it. Caddy automatically gets a free HTTPS padlock for every
// web address — you don't have to do anything for certificates.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const store = require('./../store');

// Turn your list of sites into a Caddyfile (Caddy's config format).
function buildCaddyfile() {
  const sites = store.listSites();
  let out = '';

  // Global settings (the email is used by Let's Encrypt for your certs).
  if (config.acmeEmail) {
    out += `{\n\temail ${config.acmeEmail}\n}\n\n`;
  }

  // The Perch dashboard itself.
  if (config.dashboardDomain) {
    out += `${config.dashboardDomain} {\n\treverse_proxy localhost:${config.port}\n}\n\n`;
  }

  // One block per site.
  for (const site of sites) {
    if (!site.domain || site.status === 'new') continue;

    if (site.type === 'nextjs' && site.port) {
      // Next.js: forward the web address to the running app.
      out += `${site.domain} {\n\treverse_proxy localhost:${site.port}\n\tencode gzip\n}\n\n`;
    } else {
      // Static / React: serve the built files straight from disk.
      // (This path is how the Caddy CONTAINER sees the files.)
      const root = path.posix.join(config.caddySitesPath, site.id);
      out +=
        `${site.domain} {\n` +
        `\troot * ${root}\n` +
        `\tencode gzip\n` +
        `\ttry_files {path} {path}/ /index.html\n` + // makes React Router etc. work
        `\tfile_server\n` +
        `}\n\n`;
    }
  }

  return out;
}

// Write the file, then tell the running Caddy container to reload it.
function writeAndReload() {
  fs.mkdirSync(path.dirname(config.caddyfile), { recursive: true });
  fs.writeFileSync(config.caddyfile, buildCaddyfile());

  return new Promise((resolve) => {
    // "perch-caddy" is the container name from docker-compose.yml.
    const p = spawn('docker', [
      'exec', 'perch-caddy',
      'caddy', 'reload', '--config', '/etc/caddy/Caddyfile',
    ]);
    // Best-effort: if Caddy isn't running yet (e.g. first run), don't
    // crash the deploy — the file is written and will be read on start.
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
}

module.exports = { buildCaddyfile, writeAndReload };
