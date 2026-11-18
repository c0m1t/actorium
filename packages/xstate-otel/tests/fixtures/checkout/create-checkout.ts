import { createActor } from 'xstate';
import type { Tracer } from '@opentelemetry/api';
import { createCheckoutMachine, type CheckoutServices } from './checkout.machine.js';
import { XStateTracing } from '../../../src/index.js';

export function createCheckout(options: {
  workflowId: string;
  tracer: Tracer;
  services: CheckoutServices;
  recordMicrosteps?: boolean;
}) {
  const tracing = new XStateTracing(
    options.tracer,
    options.recordMicrosteps === undefined ? {} : { recordMicrosteps: options.recordMicrosteps },
  );

  const machine = createCheckoutMachine(tracing, options.services);
  const actor = createActor(machine, {
    input: { workflowId: options.workflowId },
    inspect: tracing.inspect,
  });

  actor.start();

  // Disposable, so a test can stop the checkout with `using`.
  return { actor, tracing, [Symbol.dispose]: () => actor.stop() };
}
