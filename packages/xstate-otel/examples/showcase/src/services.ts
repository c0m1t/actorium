// In-process fakes for the services an order desk calls. Each call opens a
// CLIENT span, as HTTP client instrumentation would, so the trace shows where
// it nests. Delays are short real timers that honour the AbortSignal.
import { SpanKind, SpanStatusCode, type Tracer } from '@opentelemetry/api';

export class PaymentDeclinedError extends Error {
  override readonly name = 'PaymentDeclinedError';
  readonly code: string;

  constructor(code: string, internalMessage: string) {
    super(internalMessage);
    this.code = code;
  }
}

/** Card tokens the fake payment provider understands. */
export type Card = 'tok_ok' | 'tok_declined' | 'tok_hold';

export interface Services {
  inventory: {
    reserve(
      request: { sku: string; quantity: number },
      options: { signal: AbortSignal },
    ): Promise<{ reservationId: string }>;
  };
  payments: {
    charge(
      request: { orderId: string; card: Card },
      options: { signal: AbortSignal },
    ): Promise<{ paymentId: string }>;
    /** Number of charges abandoned through their AbortSignal. */
    readonly aborted: number;
  };
  notifier: {
    send(
      message: { orderId: string; template: 'confirmation' | 'payment_reminder' },
      options: { signal: AbortSignal },
    ): Promise<void>;
  };
  analytics: {
    track(event: { name: string }, options: { signal: AbortSignal }): Promise<void>;
    /** Every event received, traced or not. */
    readonly received: readonly string[];
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function never(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

export function createServices(tracer: Tracer): Services {
  let ids = 0;
  let aborted = 0;
  const received: string[] = [];

  const call = <T>(name: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> =>
    tracer.startActiveSpan(name, { kind: SpanKind.CLIENT }, async (span) => {
      try {
        return await run();
      } catch (error) {
        if (signal.aborted) span.addEvent('request.aborted');
        else span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });

  return {
    inventory: {
      reserve: (request, { signal }) =>
        call('POST inventory/reservations', signal, async () => {
          await wait(20, signal);
          return { reservationId: `res-${request.sku}-${++ids}` };
        }),
    },
    payments: {
      get aborted() {
        return aborted;
      },
      charge: (request, { signal }) =>
        call('POST payments/charges', signal, async () => {
          try {
            await (request.card === 'tok_hold' ? never(signal) : wait(40, signal));
          } catch (error) {
            if (signal.aborted) aborted++;
            throw error;
          }
          if (request.card === 'tok_declined') {
            throw new PaymentDeclinedError(
              'card_declined',
              `Issuer declined card ${request.card} for ${request.orderId}`,
            );
          }
          return { paymentId: `pay-${++ids}` };
        }),
    },
    notifier: {
      send: (_message, { signal }) => call('POST notifications', signal, () => wait(10, signal)),
    },
    analytics: {
      received,
      track: async (event, { signal }) => {
        received.push(event.name);
        await wait(5, signal);
      },
    },
  };
}
