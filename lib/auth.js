import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './upstream.js';

// Browser-native Basic login over loopback only; credentials never enter JS/storage.
export function createSigningAuth(env = process.env) {
  const username = 'wallet';
  const secret = env.SIGNING_PASSWORD || '';
  const configured = secret.length >= 24;
  const expected = createHash('sha256').update(username + ':' + secret).digest();
  return {
    configured,
    check(header) {
      if (!configured) throw new HttpError(503, 'Set SIGNING_PASSWORD to at least 24 characters in .env and restart before enabling transfers.');
      let supplied = '';
      if (typeof header === 'string' && header.startsWith('Basic ') && header.length < 2048) {
        supplied = Buffer.from(header.slice(6), 'base64').toString('utf8');
      }
      if (!timingSafeEqual(expected, createHash('sha256').update(supplied).digest())) throw new HttpError(401, 'Sign in as wallet with your local SIGNING_PASSWORD.');
    },
  };
}
export function createRateLimiter({ now = Date.now, limit = 60, windowMs = 60000 } = {}) {
  let start = now(), count = 0;
  return () => {
    if (now() - start >= windowMs) { start = now(); count = 0; }
    if (++count > limit) throw new HttpError(429, 'Local request limit reached. Wait one minute and retry.');
  };
}

