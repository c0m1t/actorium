import { SpanStatusCode } from '@opentelemetry/api';
import { setup } from 'xstate';
import { auditLog } from './app.js';
import { tracer, tracing } from './tracing.js';

export const machine = setup({
  actions: {
    // A synchronous action that records its own child span.
    recordAudit: ({ self }) =>
      tracing.withActiveOperation(self, () =>
        tracer.startActiveSpan('audit.record', (span) => {
          try {
            auditLog.write('accepted');
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        }),
      ),
  },
}).createMachine({ on: { ACCEPT: { actions: 'recordAudit' } } });
