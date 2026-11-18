import assert from 'node:assert/strict';
import { assign, createActor, sendTo, setup, type AnyActorRef } from 'xstate';
import type { Harness } from './harness.js';

export async function spawnedExample(h: Harness) {
  const worker = setup({ actors: { work: h.work('spawned.work') } }).createMachine({
    initial: 'working',
    states: {
      working: {
        invoke: {
          src: 'work',
          input: () => ({}),
          onDone: 'idle',
        },
      },
      idle: { on: { RUN: 'working' } },
    },
  });
  const parent = setup({
    types: { context: {} as { worker?: AnyActorRef } },
    actors: { worker },
  }).createMachine({
    context: {},
    initial: 'idle',
    states: {
      idle: {
        on: {
          START: { target: 'ready', actions: assign({ worker: ({ spawn }) => spawn('worker') }) },
        },
      },
      ready: {
        on: { AGAIN: { actions: sendTo(({ context }) => context.worker!, { type: 'RUN' }) } },
      },
    },
  });
  const actor = h.own(createActor(parent, { inspect: h.tracing.inspect }).start());
  const first = h.tracing.sendCommand(actor, { type: 'START' }, { name: 'spawned.start' });
  await h.flush();
  h.child('spawned.work', first);
  assert.equal(actor.getSnapshot().context.worker?.getSnapshot().status, 'active');
  assert.ok(h.has('spawned.start'), 'Idle spawned actor must not hold operation open');
  const second = h.tracing.sendCommand(actor, { type: 'AGAIN' }, { name: 'spawned.again' });
  await h.flush();
  const work = h.spans().filter((s) => s.name === 'spawned.work');
  assert.equal(work.length, 2);
  assert.equal(work[1]?.parentSpanContext?.spanId, second.spanId);
  assert.notEqual(first.traceId, second.traceId);
  h.findings.push(
    'PASS: a spawned machine traces initial async work, remains alive while idle, and joins a new command through sendTo.',
  );
}
