import { trace } from '@opentelemetry/api';
import { createXStateTracing } from '@actorium/xstate-otel';

// The application has already started its OpenTelemetry SDK.
export const tracer = trace.getTracer('inventory');
export const tracing = createXStateTracing({ tracer });
