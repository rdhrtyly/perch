// load-env.js — a tiny ".env" reader.
// It reads KEY=VALUE lines from a .env file and puts them into
// process.env. We wrote our own (instead of adding a package) so you
// can see exactly how it works — it's only a few lines!

const fs = require('fs');
const path = require('path');

const envPath = path.resolve(process.cwd(), '.env');

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue; // skip blanks & comments

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Remove quotes if someone wrote KEY="value"
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Don't overwrite variables that are already set in the real environment.
    if (!(key in process.env)) process.env[key] = value;
  }
}
