/**
 * Structured logger (M8.5): one JSON object per line to stdout/stderr —
 * `fly logs` and any log shipper parse it directly.
 *
 * Secrets never reach the log: fields whose names look secret-bearing are
 * scrubbed no matter who calls (the M8 security pass greps for leaks; this
 * makes the property structural instead of disciplinary).
 */

const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|jwt|cookie/i;

function scrub(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

function emit(level, event, fields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...scrub(fields),
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
  /** For tests. */
  _scrub: scrub,
};
