import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { scenarios } from './scenarios.ts';
import type { Showcase } from './showcase.ts';
import { createShowcasePage } from './source-code.ts';
import type { Telemetry } from './telemetry.ts';
import { toTraceViews } from './trace-tree.ts';

const page = createShowcasePage();

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** Serves the page and runs one scenario per `POST /api/scenarios/:id`. */
export function createShowcaseServer(telemetry: Telemetry, showcase: Showcase): Server {
  const { tracer, spans } = telemetry;

  // The SERVER span stands in for HTTP instrumentation, which the host would
  // normally install with its SDK.
  const runScenario = (path: string, id: string): Promise<{ status: number; body: unknown }> =>
    tracer.startActiveSpan(
      'POST /api/scenarios/:id',
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': 'POST',
          'http.route': '/api/scenarios/:id',
          'url.path': path,
        },
      },
      async (span) => {
        const scenario = scenarios.find((candidate) => candidate.id === id);
        const firstLog = showcase.logger.lines.length;
        let status = 200;
        let body: Record<string, unknown>;
        try {
          if (scenario) {
            body = { result: await scenario.run(showcase) };
          } else {
            status = 404;
            body = { error: `Unknown scenario ${id}` };
          }
        } catch (error) {
          status = 500;
          body = { error: String(error) };
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        // Drain tracing bookkeeping so every operation of the run has ended.
        await showcase.settle();
        span.setAttribute('http.response.status_code', status);
        span.end();
        const { traceId } = span.spanContext();
        const connected = spans.connectedTo(traceId);
        // Concurrent requests log into the same logger, so keep only the
        // lines that belong to this request's traces.
        const traceIds = new Set(connected.map((candidate) => candidate.spanContext().traceId));
        return {
          status,
          body: {
            ...body,
            logs: showcase.logger.lines
              .slice(firstLog)
              .filter((line) => line.traceId !== undefined && traceIds.has(line.traceId)),
            traces: toTraceViews(connected, traceId),
          },
        };
      },
    );

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
      return;
    }
    if (request.method === 'GET' && pathname === '/api/scenarios') {
      json(
        response,
        200,
        scenarios.map(({ id, title, shows }) => ({ id, title, shows })),
      );
      return;
    }
    const match = /^\/api\/scenarios\/([a-z-]+)$/.exec(pathname);
    if (request.method === 'POST' && match) {
      const { status, body } = await runScenario(pathname, match[1]!);
      json(response, status, body);
      return;
    }
    json(response, 404, { error: 'Not found' });
  };

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) =>
      json(response, 500, { error: String(error) }),
    );
  });
}
