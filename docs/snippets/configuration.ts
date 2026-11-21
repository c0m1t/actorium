import { SpanKind, trace } from '@opentelemetry/api';
import { createXStateTracing } from '@actorium/xstate-otel';

export const tracing = createXStateTracing({
  tracer: trace.getTracer('commerce'),
  telemetryNamespace: 'acme.workflows', // default 'actorium.xstate'
  recordMicrosteps: true,
  recordStateValues: false,
  actorIdAttribute: false,
  operationSpanKind: SpanKind.INTERNAL,
  workSpanKind: SpanKind.CLIENT,
  commonAttributes: { 'service.namespace': 'commerce' },
  operationAttributes: ({ event }) => ({ 'command.type': event.type }),
  workAttributes: ({ name }) => ({ 'work.name': name }),
  onDiagnostic: ({ phase, error }) =>
    console.warn('Tracing diagnostic', phase, error instanceof Error ? error.name : 'non-error'),
});
