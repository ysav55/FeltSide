import { timingSafeEqual } from 'node:crypto';

/**
 * CONTRACT §2 auth: one static API key, Bearer, constant-time compare.
 * Contract endpoints speak the contract's error dialect — `{ code }` —
 * not the app's `{ error }` (the CRM branches on `code`, §7).
 * The key is never logged.
 */
export function buildContractAuth(config) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(config.exportApiKey, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ code: 'invalid_api_key' });
    }
    next();
  };
}
