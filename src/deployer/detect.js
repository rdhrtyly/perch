// detect.js — figures out what kind of project a repo is, so Perch
// knows how to build and serve it.
//
// You can always OVERRIDE this by adding a small "perch.json" file to
// your repo, e.g.:
//   { "type": "static-build", "buildCommand": "npm run build", "outputDir": "dist" }

const fs = require('fs');
const path = require('path');

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function detect(repoDir) {
  // 1) An explicit perch.json in the repo always wins.
  const override = readJSON(path.join(repoDir, 'perch.json'));
  if (override && override.type) return normalize(override);

  const pkg = readJSON(path.join(repoDir, 'package.json'));

  // 2) No package.json → it's a plain static site (just HTML/CSS/JS).
  if (!pkg) {
    return { type: 'static', outputDir: pickStaticDir(repoDir), buildCommand: null, startCommand: null };
  }

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  // 3) Next.js → needs a running server (server-side rendering).
  if (deps.next) {
    return { type: 'nextjs', outputDir: null, buildCommand: 'npm run build', startCommand: 'npm start' };
  }

  // 4) Has a "build" script → assume it builds to static files
  //    (Vite, Create React App, etc.).
  if (pkg.scripts && pkg.scripts.build) {
    return { type: 'static-build', outputDir: guessBuildDir(deps), buildCommand: 'npm run build', startCommand: null };
  }

  // 5) Fallback: treat it as static.
  return { type: 'static', outputDir: pickStaticDir(repoDir), buildCommand: null, startCommand: null };
}

// Different tools put the finished site in different folders.
function guessBuildDir(deps) {
  if (deps.vite) return 'dist';             // Vite
  if (deps['react-scripts']) return 'build'; // Create React App
  return 'dist';                             // a safe common default
}

// For no-build sites, find the most likely folder to serve.
function pickStaticDir(repoDir) {
  for (const d of ['dist', 'build', 'public', 'site', '.']) {
    if (fs.existsSync(path.join(repoDir, d))) return d;
  }
  return '.';
}

function normalize(o) {
  return {
    type: o.type,
    outputDir: o.outputDir || (o.type === 'static-build' ? 'dist' : '.'),
    buildCommand: o.buildCommand || (o.type === 'static' ? null : 'npm run build'),
    startCommand: o.startCommand || (o.type === 'nextjs' ? 'npm start' : null),
  };
}

module.exports = { detect };
