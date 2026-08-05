// ─────────────────────────────────────────────────────────────────────────────
// email.mjs — outbound email via Resend, with send logging to Netlify Blobs.
//
// Used by:
//   - Waitlist endpoint (confirmation email when someone joins)
//   - Auth flow (welcome email on first Google signup)
//   - Admin broadcast (newsletter, market launch, etc.)
//
// Logs every attempt (success or failure) to `emaillog/<sendId>` so the admin
// panel can show send history, and so dedup checks like "did we already send
// this user the welcome email?" work without re-sending.
//
// Environment variables required:
//   RESEND_API_KEY  — your Resend API key (starts with re_...)
//   EMAIL_FROM      — default sender address, e.g. 'Renewonomics <hello@renewonomics.org>'
//                     (optional; falls back to 'hello@renewonomics.org' if not set)
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from 'crypto';
import { getStore }    from '@netlify/blobs';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM    = 'hello@renewonomics.org';

/** Local accessor for the same Blobs store the rest of the app uses.
 *  We don't import store.mjs's getDataStore because it isn't exported,
 *  and we want this module to stand alone. */
function getDataStore() {
  return getStore({ name: 'renewonomics', consistency: 'strong' });
}

/**
 * Send an email via Resend. Always returns an object describing the outcome
 * (never throws). The caller can decide what to do based on `ok`:
 *
 *   const result = await sendEmail({ to, subject, html });
 *   if (!result.ok) console.warn('Email failed:', result.error);
 *
 * Why never-throw: most callers (signup flow, waitlist) shouldn't fail the
 * whole user-facing operation just because email delivery hiccuped.
 *
 * @param {object} opts
 * @param {string|string[]} opts.to       — recipient email(s)
 * @param {string} opts.subject           — subject line
 * @param {string} [opts.html]            — HTML body (preferred)
 * @param {string} [opts.text]            — plain-text body (fallback for clients that can't render HTML)
 * @param {string} [opts.from]            — override the default From address
 * @param {string} [opts.replyTo]         — Reply-To header
 * @param {string} [opts.tag]             — short label for log filtering (e.g. 'welcome', 'waitlist', 'broadcast')
 * @param {string} [opts.userId]          — if known, the recipient user ID (helps dedup)
 *
 * @returns {Promise<{ok: boolean, id?: string, error?: string, status?: number, sendId: string}>}
 */
export async function sendEmail(opts) {
  const sendId  = newSendId();
  const apiKey  = process.env.RESEND_API_KEY || '';
  const from    = opts.from || process.env.EMAIL_FROM || DEFAULT_FROM;
  const to      = Array.isArray(opts.to) ? opts.to : [opts.to];
  const subject = opts.subject || '';
  const html    = opts.html || '';
  const text    = opts.text || stripHtml(html);

  // Validation — fail fast with a logged error rather than calling Resend with bad input
  const validationErr = validateInputs({ apiKey, to, subject, html, text });
  if (validationErr) {
    await logSend({
      sendId, status: 'invalid', error: validationErr,
      to, subject, from, tag: opts.tag, userId: opts.userId,
    });
    return { ok: false, error: validationErr, sendId };
  }

  // Call Resend
  let response, data;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        html,
        text,
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      }),
    });
    data = await response.json().catch(() => ({}));
  } catch (e) {
    // Network error — log and return cleanly
    await logSend({
      sendId, status: 'network_error', error: e.message,
      to, subject, from, tag: opts.tag, userId: opts.userId,
    });
    return { ok: false, error: 'Network error: ' + e.message, sendId };
  }

  if (!response.ok) {
    // Resend returned an error (4xx/5xx) — log and return
    const errMsg = data?.message || data?.name || ('HTTP ' + response.status);
    await logSend({
      sendId, status: 'failed', error: errMsg, httpStatus: response.status,
      to, subject, from, tag: opts.tag, userId: opts.userId,
    });
    return { ok: false, error: errMsg, status: response.status, sendId };
  }

  // Success — Resend returns { id: '...' }
  await logSend({
    sendId, status: 'sent', resendId: data?.id,
    to, subject, from, tag: opts.tag, userId: opts.userId,
  });
  return { ok: true, id: data?.id, sendId };
}

/**
 * Has this user already received an email tagged with this tag?
 * Used by the welcome-email flow ("don't re-send if we already sent one")
 * and by the waitlist confirmation flow.
 *
 * Note: this scans the send log. For high-volume tags we'd index by user/tag,
 * but for transactional emails (which fire ~once per user lifetime) a scan
 * is fine.
 *
 * @param {string} userId   — the recipient user ID
 * @param {string} tag      — the tag we're checking ('welcome', etc.)
 * @returns {Promise<boolean>}
 */
export async function hasSentTo(userId, tag) {
  if (!userId || !tag) return false;
  const store = getDataStore();
  try {
    const list = await store.list({ prefix: 'emaillog/' });
    const blobs = list?.blobs || [];
    // Walk newest-first; for our use case (welcome email check) we expect
    // the matching record to be near the top if it exists.
    for (const meta of blobs) {
      const log = await store.get(meta.key, { type: 'json' });
      if (!log) continue;
      if (log.userId === userId && log.tag === tag && log.status === 'sent') {
        return true;
      }
    }
  } catch {
    // If the log can't be read, default to "not sent" so the caller errs
    // on the side of sending (better than silently never sending).
    return false;
  }
  return false;
}

/**
 * Read the recent email send log for the admin panel.
 * @param {number} [limit=50]
 * @returns {Promise<Array>}
 */
export async function getRecentSends(limit = 50) {
  const store = getDataStore();
  try {
    const list  = await store.list({ prefix: 'emaillog/' });
    const blobs = (list?.blobs || []).slice(0, Math.max(1, Math.min(500, limit)));
    const records = await Promise.all(blobs.map(async meta => {
      try { return await store.get(meta.key, { type: 'json' }); }
      catch { return null; }
    }));
    return records
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  } catch {
    return [];
  }
}

// ─── internals ──────────────────────────────────────────────────────────────

function newSendId() {
  // Time-prefixed ID so the log sorts roughly by recency even without a sort,
  // and the random suffix prevents collisions if many emails fire in the same ms.
  return Date.now().toString(36) + '_' + randomBytes(6).toString('base64url');
}

function validateInputs({ apiKey, to, subject, html, text }) {
  if (!apiKey)                       return 'RESEND_API_KEY env var is not set';
  if (!to || !to.length)             return 'recipient (to) is required';
  for (const addr of to) {
    if (typeof addr !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr.trim())) {
      return 'invalid recipient address: ' + addr;
    }
  }
  if (!subject)                      return 'subject is required';
  if (!html && !text)                return 'html or text body is required';
  return null;
}

/** Strip HTML tags for a plain-text fallback body. Best-effort, not a full parser. */
function stripHtml(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Write one send record to Blobs. Failures here are silent — we never want
 *  logging issues to break the actual sending flow. */
async function logSend(record) {
  try {
    const store = getDataStore();
    const now   = new Date().toISOString();
    await store.setJSON('emaillog/' + record.sendId, {
      ...record,
      // Don't store the full HTML body in the log — too big and we already
      // have the from/to/subject which are enough for debugging.
      createdAt: now,
    });
  } catch {
    // Swallow — see comment above.
  }
}
