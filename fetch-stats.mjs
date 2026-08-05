// ─────────────────────────────────────────────────────────────────────────────
// google-verify.mjs — Verify a Google Sign-In ID token (JWT) end-to-end.
//
// What we check:
//   1. JWT structure (header.payload.signature, base64url-encoded)
//   2. Header alg is RS256 and `kid` matches one of Google's published keys
//   3. RSA signature is valid against that key
//   4. iss   ∈ {"accounts.google.com", "https://accounts.google.com"}
//   5. aud   === your GOOGLE_CLIENT_ID
//   6. exp   > now (token not expired)
//   7. iat   < now + 5 min (small skew tolerance)
//   8. email_verified is true (we don't trust unverified emails)
//
// Public keys (JWKS) are cached in-memory for ~1 hour to avoid hitting Google
// on every login. Google's certs.json contains a `cache-control` header but we
// keep it simple and just refresh when the cache is stale.
// ─────────────────────────────────────────────────────────────────────────────

import { createPublicKey, createVerify } from 'crypto';

const GOOGLE_JWKS_URL  = 'https://www.googleapis.com/oauth2/v3/certs';
const ALLOWED_ISSUERS  = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CACHE_TTL_MS     = 60 * 60 * 1000; // 1 hour

let _jwksCache = { keys: null, fetchedAt: 0 };

async function getJwks() {
  if (_jwksCache.keys && Date.now() - _jwksCache.fetchedAt < CACHE_TTL_MS) {
    return _jwksCache.keys;
  }
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error('Failed to fetch Google JWKS: HTTP ' + res.status);
  const json = await res.json();
  if (!Array.isArray(json.keys)) throw new Error('Invalid JWKS response from Google');
  _jwksCache = { keys: json.keys, fetchedAt: Date.now() };
  return json.keys;
}

/** Convert a base64url-encoded string to a Buffer. */
function b64urlToBuffer(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from((s + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function b64urlDecodeJSON(s) {
  return JSON.parse(b64urlToBuffer(s).toString('utf-8'));
}

/**
 * Verify a Google ID token and return its claims if valid.
 * Throws an Error with a descriptive message if anything is off.
 *
 * @param {string} idToken      The id_token string returned by Google Sign-In.
 * @param {string} expectedAud  Your Google OAuth Client ID (must match aud claim).
 */
export async function verifyGoogleIdToken(idToken, expectedAud) {
  if (!idToken || typeof idToken !== 'string') throw new Error('No token provided');
  if (!expectedAud) throw new Error('Server misconfigured: GOOGLE_CLIENT_ID is not set');

  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  const [headerB64, payloadB64, sigB64] = parts;
  let header, payload;
  try {
    header  = b64urlDecodeJSON(headerB64);
    payload = b64urlDecodeJSON(payloadB64);
  } catch {
    throw new Error('JWT header/payload not valid JSON');
  }

  if (header.alg !== 'RS256') throw new Error('Unsupported alg: ' + header.alg);
  if (!header.kid) throw new Error('JWT header missing kid');

  // Find the matching JWK
  const jwks = await getJwks();
  const jwk  = jwks.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('JWT signed with unknown key (kid=' + header.kid + ')');

  // Build a public key from the JWK and verify the signature
  let pubKey;
  try {
    pubKey = createPublicKey({ key: jwk, format: 'jwk' });
  } catch (e) {
    throw new Error('Failed to build public key from JWK: ' + e.message);
  }

  const signedData = Buffer.from(headerB64 + '.' + payloadB64, 'utf-8');
  const signature  = b64urlToBuffer(sigB64);
  const verifier   = createVerify('RSA-SHA256');
  verifier.update(signedData);
  verifier.end();
  const sigOk = verifier.verify(pubKey, signature);
  if (!sigOk) throw new Error('JWT signature verification failed');

  // Claim checks
  if (!ALLOWED_ISSUERS.has(payload.iss)) {
    throw new Error('Unexpected issuer: ' + payload.iss);
  }
  if (payload.aud !== expectedAud) {
    throw new Error('Token audience does not match this app');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    throw new Error('Token has expired');
  }
  if (typeof payload.iat === 'number' && payload.iat > now + 300) {
    throw new Error('Token issued in the future (clock skew?)');
  }
  if (payload.email_verified !== true) {
    throw new Error('Email not verified by Google');
  }
  if (!payload.sub) {
    throw new Error('Token missing sub claim');
  }

  return payload;
}
