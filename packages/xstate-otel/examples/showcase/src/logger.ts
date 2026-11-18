import { trace, type Attributes } from '@opentelemetry/api';

export interface LogLine {
  message: string;
  fields: Attributes;
  traceId?: string;
  spanId?: string;
}

export interface Logger {
  info(message: string, fields?: Attributes): void;
  readonly lines: readonly LogLine[];
}

/**
 * A structured logger that correlates each line with the active span and
 * records it as a span event, as OpenTelemetry log bridges do.
 */
export function createLogger(write: (line: LogLine) => void): Logger {
  const lines: LogLine[] = [];
  return {
    lines,
    info(message, fields = {}) {
      const span = trace.getActiveSpan();
      const line: LogLine = { message, fields };
      if (span) {
        const { traceId, spanId } = span.spanContext();
        Object.assign(line, { traceId, spanId });
        span.addEvent('log', { 'log.message': message, ...fields });
      }
      lines.push(line);
      write(line);
    },
  };
}
