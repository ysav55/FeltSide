/**
 * Opaque export cursor (CONTRACT §3). The CRM stores and echoes it verbatim
 * and MUST NOT parse it — the shape here is engine-internal and may change.
 *
 * v1 encoding: base64url of `v1:<export_seq>`. Anything that doesn't decode
 * to that exact shape is an invalid cursor (400 invalid_cursor).
 */

export function encodeCursor(seq) {
  return Buffer.from(`v1:${seq}`, 'utf8').toString('base64url');
}

/** Returns the seq as a string, or null when the cursor is garbage. */
export function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor === '') return null;
  let text;
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const m = /^v1:(\d{1,18})$/.exec(text);
  return m ? m[1] : null;
}
