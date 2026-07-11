import { describe, it, expect } from 'vitest';
import { log } from '../src/log.js';

describe('structured logger secret scrubbing (M8.4/M8.5)', () => {
  it('redacts secret-bearing keys at any depth', () => {
    const scrubbed = log._scrub({
      event: 'login',
      email: 'jo@school.test',
      password: 'hunter2',
      token: 'ey.jwt.here',
      nested: { api_key: 'sk-123', apiKey: 'sk-456', authorization: 'Bearer x' },
      arr: [{ jwt_secret: 'top' }, { safe: 'ok' }],
      count: 3,
    });
    expect(scrubbed.password).toBe('[redacted]');
    expect(scrubbed.token).toBe('[redacted]');
    expect(scrubbed.nested.api_key).toBe('[redacted]');
    expect(scrubbed.nested.apiKey).toBe('[redacted]');
    expect(scrubbed.nested.authorization).toBe('[redacted]');
    expect(scrubbed.arr[0].jwt_secret).toBe('[redacted]');
    // Non-secret fields survive unchanged.
    expect(scrubbed.email).toBe('jo@school.test');
    expect(scrubbed.arr[1].safe).toBe('ok');
    expect(scrubbed.count).toBe(3);
  });

  it('emits one JSON line per call with ts/level/event', () => {
    const lines = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => { lines.push(s); return true; };
    try {
      log.info('server_boot', { port: 3001, apiKey: 'nope' });
    } finally {
      process.stdout.write = orig;
    }
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('server_boot');
    expect(parsed.port).toBe(3001);
    expect(parsed.apiKey).toBe('[redacted]');
    expect(typeof parsed.ts).toBe('string');
  });
});
