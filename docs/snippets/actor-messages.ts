import { createActor, sendParent, sendTo, setup } from 'xstate';
import { tracing } from './tracing.js';

const price = tracing.fromPromise<number>('pricing.quote', async () => 42);

const worker = setup({ actors: { price } }).createMachine({
  initial: 'idle',
  states: {
    idle: { on: { QUOTE: 'quoting' } },
    quoting: {
      invoke: {
        src: 'price',
        onDone: {
          target: 'idle',
          // An immediate relay during traced processing joins the operation.
          actions: sendParent(({ event }) => ({ type: 'QUOTED', amount: event.output })),
        },
      },
    },
  },
});

const coordinator = setup({ actors: { worker } }).createMachine({
  invoke: { id: 'worker', src: 'worker' },
  initial: 'ready',
  states: {
    ready: { on: { REQUEST: { target: 'waiting', actions: sendTo('worker', { type: 'QUOTE' }) } } },
    waiting: { on: { QUOTED: 'ready' } },
  },
});

const actor = createActor(coordinator, { inspect: tracing.inspect }).start();
// One operation covers REQUEST, the relay, the quote and the reply.
await tracing.sendCommand(actor, { type: 'REQUEST' }, { name: 'pricing.request' }).finished;
