import assert from 'node:assert/strict';
import { createActor, raise, setup } from 'xstate';
import type { Harness } from './harness.js';

export async function raisedExample(h: Harness) {
  const machine = setup({ actors: { work: h.work('raised.work') } }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { START: { actions: raise({ type: 'INNER' }) }, INNER: 'transient' } },
      transient: { always: 'working' },
      working: {
        invoke: {
          src: 'work',
          input: () => ({}),
          onDone: 'done',
        },
      },
      done: {},
    },
  });
  const actor = h.own(createActor(machine, { inspect: h.tracing.inspect }).start());
  const command = h.tracing.sendCommand(actor, { type: 'START' }, { name: 'raised.start' });
  await h.flush();
  assert.equal(actor.getSnapshot().value, 'done');
  h.child('raised.work', command);
  assert.ok(
    h
      .spans()
      .find((s) => s.name === 'raised.start')
      ?.events.some((e) => e.attributes?.['actorium.xstate.event.type'] === 'INNER'),
  );
  h.findings.push(
    'PASS: immediate raise and always transitions preserve the macrostep operation, including async work started afterward. Delayed raise is covered by timers.',
  );
}
