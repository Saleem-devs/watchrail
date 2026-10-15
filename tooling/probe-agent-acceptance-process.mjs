import {
  NodeHttpExecutor,
  UndiciPinnedHttpTransport,
} from '../packages/check-engine/dist/index.js';
import { runProbeAgent } from '../apps/probe-agent/dist/main.js';

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

await runProbeAgent(process.env, { executor });
