import { createActor, setup } from 'xstate';
import { tracing } from './tracing.js';

const order = createActor(
  setup({
    types: { events: {} as { type: 'SUBMIT'; orderId: string } | { type: 'CANCEL' } },
  }).createMachine({
    initial: 'draft',
    states: {
      draft: { on: { SUBMIT: 'submitted' } },
      submitted: { tags: ['awaiting-payment'], on: { CANCEL: 'cancelled' } },
      cancelled: {},
    },
  }),
  { inspect: tracing.inspect },
).start();

const command = tracing.sendCommand(
  order,
  { type: 'SUBMIT', orderId: 'o-42' },
  { name: 'order.submit', attributes: { 'order.channel': 'web' } },
);

// @ts-expect-error -- 'SHIP' is not an event of this machine
tracing.sendCommand(order, { type: 'SHIP' }, { name: 'order.ship' });

const { outcome } = await command.finished;
if (outcome === 'completed' && order.getSnapshot().hasTag('awaiting-payment')) {
  // The business result comes from the snapshot, not from the outcome.
}
