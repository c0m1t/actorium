import { createXStateTracing, type ErrorDetails } from '@actorium/xstate-otel';
import type { Tracer } from '@opentelemetry/api';
import { createOrderDesk } from './desk.ts';
import { createLogger, type LogLine } from './logger.ts';
import { createServices, PaymentDeclinedError } from './services.ts';

export interface ShowcaseOptions {
  tracer: Tracer;
  /** Delay before a pay-later order gets a payment reminder. */
  reminderDelayMs?: number;
  log?: (line: LogLine) => void;
}

// Record a safe, stable message instead of the provider's internal text.
function errorDetails(error: unknown): ErrorDetails {
  if (error instanceof PaymentDeclinedError) {
    return {
      type: error.name,
      message: 'Payment was declined',
      attributes: { 'payment.failure_code': error.code },
    };
  }
  return error instanceof Error ? { type: error.name, message: error.message } : {};
}

export function createShowcase({
  tracer,
  reminderDelayMs = 2000,
  log = (line) => console.log(JSON.stringify(line)),
}: ShowcaseOptions) {
  const services = createServices(tracer);
  const logger = createLogger(log);

  const tracing = createXStateTracing({
    tracer,
    errorDetails,
    // Microstep span events make relays between actors visible.
    recordMicrosteps: true,
    // Delayed XState events (the payment reminder) start a linked operation.
    scheduledWorkPolicy: { mode: 'new-linked-operation', name: 'order.reminder' },
  });
  const desk = createOrderDesk({ tracing, services, logger, idPrefix: 'order', reminderDelayMs });

  // A second runtime shows a custom attribute namespace on the same machines.
  const shopTracing = createXStateTracing({
    tracer,
    errorDetails,
    attributeNamespace: 'shop.orders',
  });
  const shopDesk = createOrderDesk({
    tracing: shopTracing,
    services,
    logger,
    idPrefix: 'shop-order',
    reminderDelayMs,
  });

  return {
    services,
    logger,
    desk,
    shopDesk,
    /** Drains queued tracing bookkeeping of both runtimes. */
    async settle(): Promise<void> {
      await Promise.all([tracing.settle(), shopTracing.settle()]);
    },
    stop(): void {
      desk.stop();
      shopDesk.stop();
    },
  };
}

export type Showcase = ReturnType<typeof createShowcase>;
