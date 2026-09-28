import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { WebSocket, WebSocketServer } from 'ws';

import type {
  AcceptedResponse,
  ApiErrorBody,
  CreateSessionResponse,
} from './protocol.js';
import {
  InvalidRequestError,
  parseCreateSessionRequest,
  parseGotoRequest,
  SessionManager,
  type SessionManagerDependencies,
  SessionNotFoundError,
} from './session-manager.js';

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_UI_DIRECTORY = resolve(MODULE_DIRECTORY, '../../ui/dist');
const DEFAULT_FIXTURE_DIRECTORY = resolve(MODULE_DIRECTORY, '../../../fixtures');

type AsyncRequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction,
) => Promise<void>;

export interface OrchestratorServerOptions {
  manager?: SessionManager;
  managerDependencies?: SessionManagerDependencies;
  staticDirectory?: string | false;
  fixtureDirectory?: string | false;
  allowedOrigin?: string;
  jsonLimit?: string;
}

export interface ListenAddress {
  host: string;
  port: number;
  url: string;
}

interface HttpErrorShape {
  statusCode?: unknown;
  status?: unknown;
  code?: unknown;
}

function asyncRoute(handler: AsyncRequestHandler): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

function routeParameter(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== 'string' || value === '') {
    throw new InvalidRequestError(`Missing route parameter: ${name}`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResponse(error: unknown): { status: number; body: ApiErrorBody } {
  const shape =
    error !== null && typeof error === 'object'
      ? (error as HttpErrorShape)
      : {};
  const candidateStatus = shape.statusCode ?? shape.status;
  const status =
    typeof candidateStatus === 'number' &&
    Number.isInteger(candidateStatus) &&
    candidateStatus >= 400 &&
    candidateStatus <= 599
      ? candidateStatus
      : 500;
  const code = typeof shape.code === 'string' ? shape.code : 'internal_error';
  return {
    status,
    body: {
      error: {
        code,
        message: status === 500 ? 'Internal server error.' : errorMessage(error),
      },
    },
  };
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: number): void {
  const label = status === 404 ? 'Not Found' : 'Bad Request';
  socket.write(
    `HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

export class OrchestratorServer {
  readonly app: Express = express();
  readonly httpServer: HttpServer;
  readonly websocketServer: WebSocketServer;
  readonly manager: SessionManager;

  readonly #staticDirectory: string | false;
  readonly #fixtureDirectory: string | false;
  #started = false;
  #closed = false;

  constructor(options: OrchestratorServerOptions = {}) {
    this.manager = options.manager ?? new SessionManager(options.managerDependencies);
    this.#staticDirectory = options.staticDirectory ?? DEFAULT_UI_DIRECTORY;
    this.#fixtureDirectory = options.fixtureDirectory ?? DEFAULT_FIXTURE_DIRECTORY;
    this.httpServer = createServer(this.app);
    this.websocketServer = new WebSocketServer({ noServer: true });

    this.#configureMiddleware(options);
    this.#configureRoutes();
    this.#configureStaticFiles();
    this.#configureErrors();
    this.#configureWebSockets();
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('The orchestrator server has been closed.');
    if (this.#started) return;
    await this.manager.start();
    this.#started = true;
  }

  async listen(port = 4711, host = '127.0.0.1'): Promise<ListenAddress> {
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new InvalidRequestError(`Invalid port: ${port}`);
    }
    await this.start();
    await new Promise<void>((resolveListen, rejectListen) => {
      const handleError = (error: Error): void => rejectListen(error);
      this.httpServer.once('error', handleError);
      this.httpServer.listen(port, host, () => {
        this.httpServer.off('error', handleError);
        resolveListen();
      });
    });
    const address = this.httpServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Could not determine the orchestrator listen address.');
    }
    const displayHost = address.address === '::' ? 'localhost' : address.address;
    return {
      host: address.address,
      port: address.port,
      url: `http://${displayHost}:${address.port}`,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    let stopHttp = Promise.resolve();
    try {
      for (const client of this.websocketServer.clients) client.terminate();
      this.websocketServer.close();
      if (this.httpServer.listening) {
        // Stop accepting new work immediately, but abort browser operations
        // before waiting for active HTTP handlers such as POST /goto. Those
        // handlers may themselves be waiting on the browser context.
        stopHttp = new Promise<void>((resolveClose, rejectClose) => {
          this.httpServer.close((error) => {
            if (error === undefined) resolveClose();
            else rejectClose(error);
          });
        });
      }
      await this.manager.close();
      // A test double or a browser transport failure may leave an HTTP handler
      // promise unresolved even after its context is gone. Shutdown is already
      // committed, so force any remaining sockets closed before awaiting Node's
      // server-close callback.
      this.httpServer.closeAllConnections();
      await stopHttp;
    } finally {
      await this.manager.close().catch(() => undefined);
    }
  }

  #configureMiddleware(options: OrchestratorServerOptions): void {
    const allowedOrigin = options.allowedOrigin ?? '*';
    this.app.disable('x-powered-by');
    this.app.use((request, response, next) => {
      response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      if (request.method === 'OPTIONS') {
        response.sendStatus(204);
        return;
      }
      next();
    });
    this.app.use(express.json({ limit: options.jsonLimit ?? '1mb' }));
  }

  #configureRoutes(): void {
    this.app.get('/health', (_request, response) => {
      response.json({ ok: true });
    });

    this.app.post(
      '/session',
      asyncRoute(async (request, response) => {
        const body = parseCreateSessionRequest(request.body as unknown);
        const sessionId = await this.manager.createSession(body);
        const result: CreateSessionResponse = { sessionId };
        response.status(201).json(result);
      }),
    );

    this.app.post(
      '/session/:id/goto',
      asyncRoute(async (request, response) => {
        const sessionId = routeParameter(request, 'id');
        const url = parseGotoRequest(request.body as unknown);
        await this.manager.goto(sessionId, url);
        const result: AcceptedResponse = { accepted: true };
        response.status(202).json(result);
      }),
    );

    this.app.get(
      '/session/:id/states',
      asyncRoute(async (request, response) => {
        response.json(this.manager.getStateIndex(routeParameter(request, 'id')));
      }),
    );

    this.app.post('/session/:id/reset-history', asyncRoute(async (request, response) => {
      response.json(await this.manager.resetHistory(routeParameter(request, 'id')));
    }));

    this.app.get(
      '/session/:id/state/:stateId',
      asyncRoute(async (request, response) => {
        response.json(
          this.manager.getState(
            routeParameter(request, 'id'),
            routeParameter(request, 'stateId'),
          ),
        );
      }),
    );

    this.app.post(
      '/session/:id/input',
      asyncRoute(async (request, response) => {
        await this.manager.dispatchInput(
          routeParameter(request, 'id'),
          request.body as unknown,
        );
        const result: AcceptedResponse = { accepted: true };
        response.status(202).json(result);
      }),
    );
  }

  #configureStaticFiles(): void {
    if (this.#fixtureDirectory !== false && existsSync(this.#fixtureDirectory)) {
      this.app.use('/fixtures', express.static(this.#fixtureDirectory, { index: false }));
    }
    if (this.#staticDirectory !== false && existsSync(this.#staticDirectory)) {
      this.app.use(express.static(this.#staticDirectory, { index: 'index.html' }));
      this.app.use((request, response, next) => {
        if (
          request.method !== 'GET' ||
          request.path === '/session' ||
          request.path.startsWith('/session/') ||
          request.path === '/settings' ||
          request.path.startsWith('/settings/') ||
          request.path === '/fixtures' ||
          request.path.startsWith('/fixtures/') ||
          request.path === '/health'
        ) {
          next();
          return;
        }
        response.sendFile(join(this.#staticDirectory as string, 'index.html'), (error) => {
          if (error !== undefined) next(error);
        });
      });
    }
  }

  #configureErrors(): void {
    this.app.use((_request, response) => {
      const body: ApiErrorBody = {
        error: { code: 'not_found', message: 'Route not found.' },
      };
      response.status(404).json(body);
    });

    const handler: ErrorRequestHandler = (error, _request, response, _next) => {
      const rendered = errorResponse(error);
      response.status(rendered.status).json(rendered.body);
    };
    this.app.use(handler);
  }

  #configureWebSockets(): void {
    this.httpServer.on('upgrade', (request, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      } catch {
        rejectUpgrade(socket, 400);
        return;
      }
      const match = /^\/session\/([^/]+)\/stream\/?$/.exec(pathname);
      if (match === null || match[1] === undefined) {
        rejectUpgrade(socket, 404);
        return;
      }

      let sessionId: string;
      try {
        sessionId = decodeURIComponent(match[1]);
        this.manager.getStateIndex(sessionId);
      } catch (error) {
        rejectUpgrade(socket, error instanceof SessionNotFoundError ? 404 : 400);
        return;
      }

      this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.#attachStream(websocket, sessionId);
      });
    });
  }

  #attachStream(websocket: WebSocket, sessionId: string): void {
    const unsubscribe = this.manager.subscribe(sessionId, (event) => {
      if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(event));
    });
    websocket.once('close', unsubscribe);
    websocket.once('error', unsubscribe);
  }
}

export function createOrchestratorServer(
  options: OrchestratorServerOptions = {},
): OrchestratorServer {
  return new OrchestratorServer(options);
}

function environmentPort(): number {
  const value = process.env.PORT ?? '4711';
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

export async function runServer(): Promise<OrchestratorServer> {
  const server = createOrchestratorServer();
  let address: ListenAddress;
  try {
    address = await server.listen(
      environmentPort(),
      process.env.HOST ?? '127.0.0.1',
    );
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
  console.log(`Nexus orchestrator listening on ${address.url}`);

  const shutdown = (): void => {
    void server
      .close()
      .catch((error: unknown) => {
        console.error(`Nexus orchestrator shutdown failed: ${errorMessage(error)}`);
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  runServer().catch((error: unknown) => {
    console.error(`Nexus orchestrator failed to start: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
