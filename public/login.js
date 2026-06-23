// login.js — handles logging in and signing up.

let mode = 'login'; // or 'signup'

const form = document.getElementById('authForm');
const errorEl = document.getElementById('error');
const submitBtn = document.getElementById('submitBtn');

function setMode(m) {
  mode = m;
  const login = m === 'login';
  document.getElementById('formTitle').textContent = login ? 'Welcome back' : 'Create your account';
  document.getElementById('formSub').textContent = login ? 'Log in to your sites.' : 'Sign up — it’s free.';
  submitBtn.textContent = login ? 'Log in' : 'Sign up';
  document.getElementById('toggleText').textContent = login ? 'New here?' : 'Already have an account?';
  document.getElementById('toggleLink').textContent = login ? 'Create an account' : 'Log in';
  document.getElementById('password').autocomplete = login ? 'current-password' : 'new-password';
  errorEl.style.display = 'none';
}

document.getElementById('toggleLink').addEventListener('click', (e) => {
  e.preventDefault();
  setMode(mode === 'login' ? 'signup' : 'login');
});

// Start in signup mode if we arrived from the "Sign up free" button.
if (new URLSearchParams(location.search).has('signup')) setMode('signup');

// If already logged in, skip straight to the dashboard.
fetch('/api/auth/me').then((r) => { if (r.ok) location.href = '/'; });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.style.display = 'none';
  submitBtn.disabled = true;
  const orig = submitBtn.textContent;
  submitBtn.textContent = '…';

  const body = {
    email: document.getElementById('email').value.trim(),
    password: document.getElementById('password').value,
  };

  try {
    const r = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (r.ok) location.href = '/';
    else { errorEl.textContent = data.error || 'Something went wrong'; errorEl.style.display = 'block'; }
  } catch (err) {
    errorEl.textContent = 'Network error — try again'; errorEl.style.display = 'block';
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = orig;
  }
});
