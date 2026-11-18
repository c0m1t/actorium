import { trace } from '@opentelemetry/api';
import { createXStateTracing, type ErrorDetails } from '@actorium/xstate-otel';

class PaymentError extends Error {
  readonly code: string;
  constructor(code: string, internalMessage: string) {
    super(internalMessage);
    this.code = code;
  }
}

export const tracing = createXStateTracing({
  tracer: trace.getTracer('payments'),
  detailsUnavailableAttribute: 'app.error_details_unavailable', // or false
  errorDetails(error: unknown): ErrorDetails {
    if (error instanceof PaymentError) {
      return {
        type: 'PaymentError',
        message: 'Payment could not be completed',
        attributes: { 'payment.failure_code': error.code },
      };
    }
    return {}; // ERROR status only: no message, no exception event
  },
});
