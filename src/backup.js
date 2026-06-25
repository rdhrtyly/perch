// backup.js — automatic safety copies of Perch's important records
// (accounts, sites, tokens, settings, stats...). Once a day it snapshots
// the small JSON state files into data/backups/<timestamp>/ and keeps the
// most recent few, so a bad edit, a crash, or a fat-fingered delete can't
// wipe your data. Pure fs — no extra packages, no setup.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const activity = require('./activity');

const BACKUP_DIR = path.join(config.dataDir, 'backups');
const DAY_MS = 24 * 60 * 60 * 1000;

// Copy every *.json file sitting directly in data/ into a fresh timestamped
// folder. These files are small and hold the irreplaceable records.
function runBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, stamp);
    fs.mkdirSync(dest, { recursive: true });

    let count = 0;
    for (const name of fs.readdirSync(config.dataDir)) {
      if (!name.endsWith('.json')) continue; // only the state files
      const src = path.join(config.dataDir, name);
      try {
        if (!fs.statSync(src).isFile()) continue;
        fs.copyFileSync(src, path.join(dest, name));
        count++;
      } catch { /* skip a file that vanished mid-copy */ }
    }
    prune();
    return { ok: true, dest, count };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Keep only the most recent N backups; delete the rest.
function prune() {
  let dirs;
  try { dirs = backupDirs(); } catch { return; }
  for (const old of dirs.slice(0, Math.max(0, dirs.length - config.backupKeep))) {
    fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
  }
}

// Backup folder names, oldest first (ISO timestamps sort chronologically).
function backupDirs() {
  return fs.readdirSync(BACKUP_DIR)
    .filter((d) => {
      try { return fs.statSync(path.join(BACKUP_DIR, d)).isDirectory(); } catch { return false; }
    })
    .sort();
}

// Newest first — for showing in the dashboard later.
function listBackups() {
  try { return backupDirs().reverse(); } catch { return []; }
}

// One backup shortly after startup, then once every day.
function start() {
  const once = () => {
    const r = runBackup();
    if (r.ok) activity.log('backup', `saved a backup (${r.count} files)`);
  };
  setTimeout(once, 30000);
  setInterval(once, DAY_MS).unref?.();
}

module.exports = { runBackup, listBackups, start };
