// system.js — reads how the machine is doing: memory, disk, containers.
//
// Memory works everywhere (Node's os module). Disk + Docker only work on
// the Linux droplet; off-Linux (e.g. local dev) they return null/[] so
// callers degrade gracefully instead of crashing.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function memory() {
  const total = os.totalmem(), free = os.freemem();
  return { total, free, used: total - free, pct: Math.round(((total - free) / total) * 100) };
}

function disk() {
  try {
    const cols = execSync('df -kP /', { encoding: 'utf8' }).trim().split('\n').pop().split(/\s+/);
    const total = Number(cols[1]) * 1024, used = Number(cols[2]) * 1024, free = Number(cols[3]) * 1024;
    if (Number.isFinite(total) && total > 0) return { total, used, free, pct: Math.round((used / total) * 100) };
  } catch { /* no df here */ }
  return null;
}

// Names of running Docker containers, or null if Docker isn't reachable.
function dockerNames() {
  try { return execSync('docker ps --format "{{.Names}}"', { encoding: 'utf8' }).split('\n').filter(Boolean); }
  catch { return null; }
}

function containerCount() {
  const names = dockerNames();
  return names ? names.length : null;
}

// Total bytes on disk under a folder (recursive).
function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : (fs.statSync(p).size || 0);
    }
  } catch { /* missing dir */ }
  return total;
}

module.exports = { memory, disk, dockerNames, containerCount, dirSize };
