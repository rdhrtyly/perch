// templates.js — built-in starter sites you can deploy with one click,
// no upload needed. Each template is just a small set of static files.

const PAGE = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; text-align:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background: radial-gradient(900px 500px at 50% -150px, rgba(216,180,90,.16), transparent 60%), #0b0b0d;
    color:#f4f1ea; padding:32px; }
  h1 { font-size:clamp(34px,7vw,64px); margin:0 0 14px; background:linear-gradient(135deg,#f3d489,#d8b45a 55%,#bf9b3e);
    -webkit-background-clip:text; background-clip:text; color:transparent; }
  p { color:#a8a39a; font-size:18px; max-width:560px; margin:0 auto; line-height:1.6; }
  .tag { display:inline-block; margin-bottom:22px; font-size:12px; letter-spacing:2px; text-transform:uppercase;
    color:#f1d488; border:1px solid rgba(216,180,90,.3); border-radius:999px; padding:6px 14px; }
  a.cta { display:inline-block; margin-top:26px; padding:13px 26px; border-radius:12px; text-decoration:none; font-weight:600;
    color:#0b0b0d; background:linear-gradient(135deg,#f3d489,#d8b45a 55%,#bf9b3e); }
</style></head><body><main>${body}</main></body></html>`;

const TEMPLATES = {
  blank: {
    label: 'Blank page',
    files: [{ path: 'index.html', content: PAGE('My new site', `<span class="tag">Perch</span><h1>Hello, world</h1><p>Your new site is live. Edit <code>index.html</code> and redeploy to make it yours.</p>`) }],
  },
  'coming-soon': {
    label: 'Coming soon',
    files: [{ path: 'index.html', content: PAGE('Coming soon', `<span class="tag">Coming soon</span><h1>Something is on the way</h1><p>We're putting the finishing touches on it. Check back soon.</p><a class="cta" href="#">Notify me</a>`) }],
  },
  portfolio: {
    label: 'Portfolio',
    files: [{ path: 'index.html', content: PAGE('My portfolio', `<span class="tag">Portfolio</span><h1>Your Name</h1><p>I build things on the web. This is my little corner of the internet — projects, writing, and ways to reach me.</p><a class="cta" href="#">See my work</a>`) }],
  },
};

function list() { return Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label })); }
function files(id) { return TEMPLATES[id] ? TEMPLATES[id].files : null; }

module.exports = { list, files };
