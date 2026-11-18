import assert from 'node:assert/strict';
import { createActor, sendParent, sendTo, setup } from 'xstate';
import type { Harness } from './harness.js';

export async function sendingExample(h: Harness) {
  const worker = setup({ actors: { work: h.work('sending.worker') } }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { RUN: 'working' } },
      working: {
        invoke: {
          src: 'work',
          input: () => ({}),
          onDone: { target: 'idle', actions: sendParent({ type: 'REPLY' }) },
        },
      },
    },
  });
  const parent = setup({ actors: { worker, followup: h.work('sending.followup') } }).createMachine({
    invoke: { id: 'worker', src: 'worker' },
    initial: 'idle',
    states: {
      idle: { on: { START: { target: 'waiting', actions: sendTo('worker', { type: 'RUN' }) } } },
      waiting: { on: { REPLY: 'followup' } },
      followup: {
        invoke: {
          src: 'followup',
          input: () => ({}),
          onDone: 'done',
        },
      },
      done: {},
    },
  });
  const actor = h.own(createActor(parent, { inspect: h.tracing.inspect }).start());
  const command = h.tracing.sendCommand(actor, { type: 'START' }, { name: 'sending.start' });
  await h.flush();
  assert.equal(actor.getSnapshot().value, 'done');
  h.child('sending.worker', command);
  h.child('sending.followup', command);
  h.findings.push(
    'PASS: sendTo → async worker → sendParent reply → async followup stays in one operation in a shared inspected system.',
  );

  // Calling ActorRef.send directly carries no sourceRef in inspection.
  const directWorker = setup({ actors: { work: h.work('sending.direct.work') } }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { RUN: 'working' } },
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
  const target = h.own(createActor(directWorker, { inspect: h.tracing.inspect }).start());
  const sender = h.own(
    createActor(
      setup({}).createMachine({ on: { START: { actions: () => target.send({ type: 'RUN' }) } } }),
      { inspect: h.tracing.inspect },
    ).start(),
  );
  h.tracing.sendCommand(sender, { type: 'START' }, { name: 'sending.direct' });
  await h.flush();
  assert.equal(target.getSnapshot().value, 'done');
  assert.equal(h.has('sending.direct.work'), false);
  h.findings.push(
    'GAP: calling another actor.send() directly from an action loses the source association, even with the same tracing instance.',
  );
}
