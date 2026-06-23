// ═══════════════════════════════════════════════════════════════════
//   PHASE 2 — Porkbun domain buying  (now implemented!)
//   -----------------------------------------------------------------
//   Buy domains right from the dashboard:
//     • checkAvailability  → is it free? how much?
//     • registerDomain     → actually buy it (supports a safe dryRun)
//     • pointDomainAtServer→ auto-add DNS so it points at this server
//
//   Keys come from config.porkbun (read from .env). Nothing else in
//   Perch had to change — the seams were left in Phase 1.
//
//   Porkbun API docs: https://porkbun.com/api/json/v3/documentation
// ═══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const config = require('../config');

const BASE = 'https://api.porkbun.com/api/json/v3';

// Is domain-buying switched on? (true once both keys are in .env)
function enabled() {
  return config.porkbun.enabled;
}

// Small helper: every Porkbun call is a POST with the keys in the body.
async function pb(path, body = {}, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({
      apikey: config.porkbun.apiKey,
      secretapikey: config.porkbun.secretKey,
      ...body,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.status !== 'SUCCESS') {
    throw new Error(data.message || `Porkbun request failed (${path})`);
  }
  return data;
}

// 1) Is the domain available, and what does it cost?
async function checkAvailability(domain) {
  const data = await pb(`/domain/checkDomain/${encodeURIComponent(domain)}`);
  const r = data.response || {};
  return {
    domain,
    available: r.avail === 'yes',
    price: r.price != null ? Number(r.price) : null,          // first-year price, USD
    regularPrice: r.regularPrice != null ? Number(r.regularPrice) : null,
    premium: r.premium === 'yes',
  };
}

// 2) Buy the domain. Pass { dryRun: true } to validate WITHOUT being charged.
async function registerDomain(domain, { dryRun = false } = {}) {
  // Re-check first so we send the exact current price (Porkbun requires a match).
  const info = await checkAvailability(domain);
  if (!info.available) throw new Error(`${domain} isn't available to buy`);
  if (info.price == null) throw new Error(`Couldn't get a price for ${domain}`);

  const costCents = Math.round(info.price * 100);

  await pb(
    `/domain/create/${encodeURIComponent(domain)}`,
    {
      cost: costCents,
      agreeToTerms: 'yes',
      ...(dryRun ? { dryRun: true } : {}),
    },
    // An idempotency key stops a retry from double-charging you.
    { 'Idempotency-Key': crypto.randomUUID() }
  );

  return { domain, price: info.price, costCents, dryRun };
}

// 3) Point the domain (and every subdomain) at this server.
async function pointDomainAtServer(domain, serverIp) {
  if (!serverIp) throw new Error('SERVER_IP is not set in .env');
  // Root "@" record + wildcard "*" record, both A records to our IP.
  await pb(`/dns/create/${encodeURIComponent(domain)}`, { name: '', type: 'A', content: serverIp, ttl: '600' });
  await pb(`/dns/create/${encodeURIComponent(domain)}`, { name: '*', type: 'A', content: serverIp, ttl: '600' });
  return { domain, serverIp };
}

module.exports = { enabled, checkAvailability, registerDomain, pointDomainAtServer };
