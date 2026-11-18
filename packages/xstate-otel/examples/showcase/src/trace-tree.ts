import { SpanKind, SpanStatusCode, type Attributes, type HrTime } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

export interface SpanView {
  name: string;
  spanId: string;
  kind: string;
  /** Milliseconds from the earliest span in the view. */
  startMs: number;
  durationMs: number;
  status: 'unset' | 'ok' | 'error';
  statusMessage?: string;
  attributes: Attributes;
  events: { name: string; offsetMs: number; attributes: Attributes }[];
  links: { traceId: string; spanId: string; name?: string }[];
  children: SpanView[];
}

export interface TraceView {
  traceId: string;
  roots: SpanView[];
}

const ms = ([seconds, nanos]: HrTime): number => seconds * 1e3 + nanos / 1e6;
const round = (value: number): number => Math.round(value * 10) / 10;
const statuses = {
  [SpanStatusCode.UNSET]: 'unset',
  [SpanStatusCode.OK]: 'ok',
  [SpanStatusCode.ERROR]: 'error',
} as const;

/**
 * Groups spans into traces of parent/child trees. `firstTraceId` comes first;
 * the others follow by start time, which is approximate across traces because
 * the SDK anchors each root span's clock separately.
 */
export function toTraceViews(spans: readonly ReadableSpan[], firstTraceId?: string): TraceView[] {
  const sorted = [...spans].sort((a, b) => ms(a.startTime) - ms(b.startTime));
  const origin = sorted[0] ? ms(sorted[0].startTime) : 0;
  const names = new Map(sorted.map((span) => [span.spanContext().spanId, span.name]));
  const views = new Map<string, SpanView>();
  const traces = new Map<string, TraceView>();

  for (const span of sorted) {
    const start = ms(span.startTime);
    views.set(span.spanContext().spanId, {
      name: span.name,
      spanId: span.spanContext().spanId,
      kind: SpanKind[span.kind].toLowerCase(),
      startMs: round(start - origin),
      durationMs: round(ms(span.duration)),
      status: statuses[span.status.code],
      ...(span.status.message ? { statusMessage: span.status.message } : {}),
      attributes: span.attributes,
      events: span.events.map((event) => ({
        name: event.name,
        offsetMs: round(ms(event.time) - start),
        attributes: event.attributes ?? {},
      })),
      links: span.links.map(({ context }) => {
        const name = names.get(context.spanId);
        return { traceId: context.traceId, spanId: context.spanId, ...(name ? { name } : {}) };
      }),
      children: [],
    });
  }

  for (const span of sorted) {
    const view = views.get(span.spanContext().spanId)!;
    const parent = views.get(span.parentSpanContext?.spanId ?? '');
    if (parent) {
      parent.children.push(view);
      continue;
    }
    const traceId = span.spanContext().traceId;
    const trace = traces.get(traceId) ?? { traceId, roots: [] };
    trace.roots.push(view);
    traces.set(traceId, trace);
  }
  const first = firstTraceId === undefined ? undefined : traces.get(firstTraceId);
  return first
    ? [first, ...[...traces.values()].filter((trace) => trace !== first)]
    : [...traces.values()];
}
