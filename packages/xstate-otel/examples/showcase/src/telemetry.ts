import { context, trace, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/** Keeps the most recent finished spans in memory for the page. */
class SpanStore implements SpanProcessor {
  readonly #spans: ReadableSpan[] = [];
  readonly #limit: number;

  constructor(limit = 5000) {
    this.#limit = limit;
  }

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    this.#spans.push(span);
    if (this.#spans.length > this.#limit) this.#spans.splice(0, this.#spans.length - this.#limit);
  }

  /** Spans of `traceId` and of every trace connected to it by links, in either direction. */
  connectedTo(traceId: string): ReadableSpan[] {
    const traces = new Set([traceId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const span of this.#spans) {
        const own = span.spanContext().traceId;
        for (const link of span.links) {
          const linked = link.context.traceId;
          if (traces.has(own) !== traces.has(linked)) {
            traces.add(own).add(linked);
            grew = true;
          }
        }
      }
    }
    return this.#spans.filter((span) => traces.has(span.spanContext().traceId));
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface Telemetry {
  tracer: Tracer;
  spans: SpanStore;
  shutdown(): Promise<void>;
}

/**
 * The host application owns the SDK. Spans always go to the in-memory store
 * that feeds the page; with OTEL_EXPORTER_OTLP_ENDPOINT set they are also
 * exported over OTLP/HTTP, for example to Jaeger from compose.yaml.
 */
export function startTelemetry(env: NodeJS.ProcessEnv = process.env): Telemetry {
  const spans = new SpanStore();
  const processors: SpanProcessor[] = [spans];
  if (env['OTEL_EXPORTER_OTLP_ENDPOINT']) {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      'service.name': env['OTEL_SERVICE_NAME'] ?? 'xstate-otel-showcase',
    }),
    spanProcessors: processors,
  });
  // Promise work and client calls need the active context across awaits.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  return {
    tracer: provider.getTracer('xstate-otel-showcase'),
    spans,
    async shutdown() {
      await provider.shutdown();
      context.disable();
      trace.disable();
    },
  };
}
