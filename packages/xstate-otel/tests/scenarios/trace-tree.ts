import { SpanKind, SpanStatusCode, type Attributes } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

export function printSpanForest(title: string, spans: ReadableSpan[]): void {
  console.log(`\n=== ${title} ===`);

  const traces = new Map<string, ReadableSpan[]>();
  for (const span of spans) {
    const traceId = span.spanContext().traceId;
    const traceSpans = traces.get(traceId) ?? [];
    traceSpans.push(span);
    traces.set(traceId, traceSpans);
  }

  for (const [traceId, traceSpans] of traces) {
    console.log(`\nTRACE ${traceId}`);
    const spanIds = new Set(traceSpans.map((span) => span.spanContext().spanId));
    const children = new Map<string, ReadableSpan[]>();
    const roots: ReadableSpan[] = [];

    for (const span of traceSpans) {
      const parentId = span.parentSpanContext?.spanId;
      if (!parentId || !spanIds.has(parentId)) {
        roots.push(span);
        continue;
      }
      const siblings = children.get(parentId) ?? [];
      siblings.push(span);
      children.set(parentId, siblings);
    }

    roots.sort(byStartTime);
    for (let index = 0; index < roots.length; index += 1) {
      printSpan(roots[index]!, children, '', index === roots.length - 1);
    }
  }
}

function printSpan(
  span: ReadableSpan,
  children: Map<string, ReadableSpan[]>,
  prefix: string,
  last: boolean,
): void {
  const branch = last ? '└─' : '├─';
  const context = span.spanContext();
  const status = SpanStatusCode[span.status.code];
  console.log(
    `${prefix}${branch} ${span.name} ` +
      `[${SpanKind[span.kind]} ${status}] ` +
      `span=${context.spanId} parent=${span.parentSpanContext?.spanId ?? 'ROOT'} ` +
      `${durationMs(span).toFixed(2)}ms`,
  );

  const detailsPrefix = `${prefix}${last ? '   ' : '│  '}`;
  const selected = selectAttributes(span.attributes);
  if (selected.length > 0) {
    console.log(`${detailsPrefix}attrs: ${selected.join(' ')}`);
  }
  for (const link of span.links) {
    console.log(`${detailsPrefix}link: trace=${link.context.traceId} span=${link.context.spanId}`);
  }

  const microsteps = span.events
    .filter((event) => event.name === 'actorium.xstate.microstep')
    .map((event) => event.attributes?.['actorium.xstate.event.type'])
    .filter((value): value is string => typeof value === 'string');
  if (microsteps.length > 0) {
    console.log(`${detailsPrefix}events: ${microsteps.join(' → ')}`);
  }

  const childSpans = children.get(context.spanId) ?? [];
  childSpans.sort(byStartTime);
  for (let index = 0; index < childSpans.length; index += 1) {
    printSpan(childSpans[index]!, children, detailsPrefix, index === childSpans.length - 1);
  }
}

function selectAttributes(attributes: Attributes): string[] {
  const preferred = [
    'demo.scenario',
    'workflow.id',
    'actorium.xstate.operation.event_type',
    'actorium.xstate.operation.outcome',
    'actorium.xstate.operation.had_error',
    'actorium.xstate.work.outcome',
    'rpc.system',
    'db.system',
  ];
  return preferred.flatMap((key) => {
    const value = attributes[key];
    return value === undefined ? [] : [`${key}=${JSON.stringify(value)}`];
  });
}

function durationMs(span: ReadableSpan): number {
  return span.duration[0] * 1_000 + span.duration[1] / 1_000_000;
}

function byStartTime(left: ReadableSpan, right: ReadableSpan): number {
  return left.startTime[0] === right.startTime[0]
    ? left.startTime[1] - right.startTime[1]
    : left.startTime[0] - right.startTime[0];
}
