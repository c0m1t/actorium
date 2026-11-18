import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import type { AnyActorRef } from 'xstate';
import { bus } from './app.js';
import { tracing } from './tracing.js';

// Publisher: finite work that injects the active context into the envelope.
export const publish = tracing.fromPromise<void, { orderId: string }>(
  'order.publish',
  async ({ input }) => {
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);
    await bus.publish({ data: input, headers });
  },
);

// Consumer: each message is a new command linked to the publisher's span.
export function consume(actor: AnyActorRef): () => void {
  return bus.subscribe((message) => {
    const upstream = propagation.extract(ROOT_CONTEXT, message.headers);
    tracing.sendCommand(
      actor,
      { type: 'MESSAGE', data: message.data },
      { name: 'order.consume', parentContext: upstream },
    );
  });
}
