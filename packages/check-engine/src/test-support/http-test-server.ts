import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createServer as createHttpsServer,
  type ServerOptions as HttpsServerOptions,
} from 'node:https';

export interface CapturedHttpRequest {
  method: string;
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface HttpTestServer {
  port: number;
  address: '127.0.0.1';
  requests: CapturedHttpRequest[];
  close(): Promise<void>;
}

export async function startHttpTestServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<HttpTestServer> {
  const requests: CapturedHttpRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: { ...request.headers },
    });
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error('HTTP test handler failed.'));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the HTTP test server to have a TCP address.');
  }

  return {
    port: address.port,
    address: '127.0.0.1',
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function startHttpsTestServer(
  options: HttpsServerOptions,
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<HttpTestServer> {
  const requests: CapturedHttpRequest[] = [];
  const server = createHttpsServer(options, (request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: { ...request.headers },
    });
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error('HTTPS test handler failed.'));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the HTTPS test server to have a TCP address.');
  }

  return {
    port: address.port,
    address: '127.0.0.1',
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
