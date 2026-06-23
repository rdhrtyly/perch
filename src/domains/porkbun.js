// ═══════════════════════════════════════════════════════════════════
//   PHASE 2 LIVES HERE  —  Porkbun domain buying
//   -----------------------------------------------------------------
//   Right now these functions are placeholders. When we build Phase 2,
//   we fill them in using the Porkbun API. Nothing else in Perch has
//   to change, because we already prepared the seams:
//
//     • Your keys arrive automatically via config.porkbun (from .env)
//     • The dashboard "add a site" flow already stores `domainSource`,
//       so a bought domain just sets domainSource = "porkbun".
//     • caddy.js already serves whatever `domain` a site has, custom
//       or subdomain — no change needed there either.
//
//   Porkbun API docs: https://porkbun.com/api/json/v3/documentation
// ═══════════════════════════════════════════════════════════════════

const config = require('../config');

// Is domain-buying switched on? (Becomes true once keys are in .env.)
function enabled() {
  return config.porkbun.enabled;
}

// 1) Check if a domain is available to buy, and how much it costs.
async function checkAvailability(domain) {
  throw new Error('Phase 2 not built yet: checkAvailability');
  // TODO (Phase 2):
  //   POST https://api.porkbun.com/api/json/v3/domain/checkDomain/<domain>
  //   body: { apikey: config.porkbun.apiKey, secretapikey: config.porkbun.secretKey }
  //   -> return { available: true/false, price }
}

// 2) Register (buy) a domain.
async function registerDomain(domain) {
  throw new Error('Phase 2 not built yet: registerDomain');
  // TODO (Phase 2): call Porkbun's purchase endpoint, then return success.
}

// 3) Point a domain at this server (add DNS records).
async function pointDomainAtServer(domain, serverIp) {
  throw new Error('Phase 2 not built yet: pointDomainAtServer');
  // TODO (Phase 2): use Porkbun "dns/create" to add:
  //   • an A record  @  -> serverIp
  //   • a wildcard A record  *  -> serverIp  (so every subdomain works)
}

module.exports = { enabled, checkAvailability, registerDomain, pointDomainAtServer };
