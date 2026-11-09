import { HttpError } from './upstream.js';
// Best-effort per-client limit in each function instance. Provider quotas and
// Vercel's edge controls remain the deployment-wide limit.
export function createClientRateLimiter({ now = Date.now, limit = 240, windowMs = 60000, maxClients = 4096 } = {}) {
  const clients = new Map();
  return key => {
    const time = now(); let entry = clients.get(key);
    if (!entry || time >= entry.reset) {
      if (clients.size >= maxClients) {
        for (const [id, item] of clients) if (time >= item.reset) clients.delete(id);
        if (clients.size >= maxClients) clients.delete(clients.keys().next().value);
      }
      entry = { count: 0, reset: time + windowMs }; clients.set(key, entry);
    }
    if (++entry.count > limit) throw new HttpError(429, 'Request limit reached. Wait one minute and retry.');
  };
}
