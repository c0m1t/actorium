import { setup } from 'xstate';
import { inventory, type Reservation } from './app.js';
import { tracing } from './tracing.js';

// Generic order: output, input, emitted events (optional).
const reserveStock = tracing.fromPromise<Reservation, { sku: string; quantity: number }>(
  'inventory.reserve',
  async ({ input, signal }) => inventory.reserve(input, { signal }),
  { attributes: { 'inventory.region': 'eu-west' } },
);

export const machine = setup({
  types: { context: {} as { sku: string } },
  actors: { reserveStock },
}).createMachine({
  context: { sku: 'ABC-1' },
  initial: 'reserving',
  states: {
    reserving: {
      invoke: {
        src: 'reserveStock',
        // Ordinary business input: no tracing fields.
        input: ({ context }) => ({ sku: context.sku, quantity: 1 }),
        onDone: 'reserved',
        onError: 'failed',
      },
    },
    reserved: {},
    failed: {},
  },
});
