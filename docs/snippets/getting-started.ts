import { assign, createActor, setup } from 'xstate';
import { inventory } from './app.js';
import { tracing } from './tracing.js';

const lookup = tracing.fromPromise<number, { sku: string }>(
  'inventory.lookup',
  async ({ input, signal }) => inventory.available(input.sku, { signal }),
);

const machine = setup({
  types: {
    context: {} as { sku: string; available: number },
    events: {} as { type: 'LOOKUP'; sku: string },
  },
  actors: { lookup },
}).createMachine({
  context: { sku: '', available: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        LOOKUP: { target: 'loading', actions: assign({ sku: ({ event }) => event.sku }) },
      },
    },
    loading: {
      invoke: {
        src: 'lookup',
        input: ({ context }) => ({ sku: context.sku }),
        onDone: { target: 'ready', actions: assign({ available: ({ event }) => event.output }) },
        onError: 'failed',
      },
    },
    ready: {
      on: {
        LOOKUP: { target: 'loading', actions: assign({ sku: ({ event }) => event.sku }) },
      },
    },
    failed: {},
  },
});

// Attach the inspector when the root actor is created.
const actor = createActor(machine, { inspect: tracing.inspect }).start();

const command = tracing.sendCommand(
  actor,
  { type: 'LOOKUP', sku: 'ABC-1' },
  { name: 'inventory.check' },
);
const { outcome, hadError } = await command.finished; // telemetry settled
console.log(outcome, hadError, actor.getSnapshot().value); // business result
