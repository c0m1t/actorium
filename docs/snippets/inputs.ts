import { setup, spawnChild } from 'xstate';
import { tracing } from './tracing.js';

// A function as the input value: tracing never calls or wraps it.
const load = async (sku: string) => `loaded:${sku}`;
const callableWork = tracing.fromPromise<string, typeof load>(
  'product.callable_load',
  async ({ input }) => input('ABC-1'),
);

// Primitive input needs nothing special.
const square = tracing.fromPromise<number, number>(
  'number.square',
  async ({ input }) => input * input,
);

export const machine = setup({ actors: { square } }).createMachine({
  // A direct logic reference: named spawns treat a function input as a mapper.
  entry: spawnChild(callableWork, { input: load }),
  invoke: { src: 'square', input: 7 },
});
