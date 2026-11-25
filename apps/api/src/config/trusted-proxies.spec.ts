import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { trustedProxyPredicate } from './trusted-proxies.js';

function app(proxies: string) {
  const server = express();
  server.set('trust proxy', trustedProxyPredicate(proxies));
  const allowances = new Map<string, number>();
  server.get('/', (req, res) => {
    const count = (allowances.get(req.ip!) ?? 0) + 1;
    allowances.set(req.ip!, count);
    res.status(count > 1 ? 429 : 200).json({ ip: req.ip });
  });
  return server;
}

describe('constrained proxy trust', () => {
  it('separates visitors forwarded by the configured local frontend proxy', async () => {
    const server = app('127.0.0.1/32,::1/128');
    await request(server)
      .get('/')
      .set('X-Forwarded-For', '198.51.100.1')
      .expect(200, { ip: '198.51.100.1' });
    await request(server)
      .get('/')
      .set('X-Forwarded-For', '198.51.100.2')
      .expect(200, { ip: '198.51.100.2' });
    await request(server).get('/').set('X-Forwarded-For', '198.51.100.1').expect(429);
  });
  it('ignores forged forwarding headers from an untrusted socket peer', async () => {
    const server = app('192.0.2.10');
    const first = await request(server).get('/').set('X-Forwarded-For', '198.51.100.1').expect(200);
    const second = await request(server)
      .get('/')
      .set('X-Forwarded-For', '198.51.100.2')
      .expect(429);
    expect(first.body).toEqual(second.body);
    expect(first.body.ip).not.toBe('198.51.100.1');
  });
  it('stops at the nearest untrusted hop rather than using a forged leftmost address', async () => {
    await request(app('127.0.0.1/32,::1/128'))
      .get('/')
      .set('X-Forwarded-For', '203.0.113.99, 198.51.100.1')
      .expect(200, { ip: '198.51.100.1' });
  });
  it('rejects blanket trust, hostnames and hop counts', () => {
    for (const value of ['true', '1', '*', 'localhost', '0.0.0.0/0', '::/0']) {
      expect(() => trustedProxyPredicate(value)).toThrow('API_TRUSTED_PROXIES');
    }
    expect(trustedProxyPredicate(undefined)('127.0.0.1')).toBe(false);
  });
});
