import {
  NodeHttpExecutor,
  UndiciPinnedHttpTransport,
} from '../packages/check-engine/dist/index.js';
import { runProbeAgent } from '../apps/probe-agent/dist/main.js';
import { appendFile } from 'node:fs/promises';

if (process.env.NODE_ENV !== 'test') {
  throw new Error('The acceptance probe process can run only with NODE_ENV=test.');
}

const transport = new UndiciPinnedHttpTransport();
const executor = new NodeHttpExecutor({
  resolver: {
    lookup() {
      return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
    },
  },
  transport: {
    request(input) {
      return transport.request({
        ...input,
        headers: [
          ...(input.headers ?? []),
          ...(process.env.PROBE_ACCEPTANCE_LOCATION
            ? [
                {
                  name: 'x-watchrail-acceptance-location',
                  value: process.env.PROBE_ACCEPTANCE_LOCATION,
                },
              ]
            : []),
        ],
        target: {
          ...input.target,
          // Test-only network seam: preserve production URL validation while routing the
          // already-approved acceptance hostname to the deterministic local HTTP fixture.
          addresses: [{ address: '127.0.0.1', family: 4 }],
        },
      });
    },
  },
});

const captureFile = process.env.PROBE_ACCEPTANCE_SUBMISSION_CAPTURE_FILE;
const fetcher = captureFile
  ? async (input, init) => {
      const url = String(input);
      if (url.endsWith('/results')) {
        await appendFile(
          captureFile,
          `${JSON.stringify({
            kind: 'request',
            url,
            authorization: new globalThis.Headers(init?.headers).get('authorization'),
            claimToken: new globalThis.Headers(init?.headers).get('x-watchrail-claim-token'),
            body: init?.body,
          })}\n`,
          'utf8',
        );
        const delay = Number(process.env.PROBE_ACCEPTANCE_SUBMISSION_DELAY_MS ?? '0');
        if (Number.isFinite(delay) && delay > 0) {
          await new Promise((resolve) => globalThis.setTimeout(resolve, delay));
        }
      }
      const response = await globalThis.fetch(input, init);
      if (url.endsWith('/results')) {
        await appendFile(
          captureFile,
          `${JSON.stringify({ kind: 'response', url, status: response.status })}\n`,
          'utf8',
        );
      }
      return response;
    }
  : globalThis.fetch;

await runProbeAgent(process.env, { executor, fetcher });
