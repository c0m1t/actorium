import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { AnyActorRef } from 'xstate';
import { tracing } from './tracing.js';

// Call while `actor` is processing traced work, e.g. from an action.
export function retryLater(actor: AnyActorRef, delayMs: number): void {
  // Keep only the span context: the origin operation is free to end.
  const parentContext = tracing.withActiveOperation(actor, () => {
    const origin = trace.getSpanContext(context.active());
    return origin ? trace.setSpanContext(ROOT_CONTEXT, origin) : ROOT_CONTEXT;
  });
  setTimeout(() => {
    tracing.sendCommand(actor, { type: 'RETRY' }, { name: 'checkout.retry', parentContext });
  }, delayMs);
}
