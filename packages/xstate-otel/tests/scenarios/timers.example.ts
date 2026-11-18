import assert from 'node:assert/strict';
import { createActor, raise, sendTo, setup } from 'xstate';
import { createXStateTracing } from '../../src/index.js';
import type { Harness } from './harness.js';

// A deterministic clock separates the command turn from delayed delivery.
export async function timersExample(h: Harness) {
  for (const mode of ['after', 'raise', 'sendTo'] as const) {
    const name = `timer.${mode}.work`;
    const machine = setup({ actors: { work: h.work(name) } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { START: 'waiting' } },
        waiting: {
          ...(mode === 'after'
            ? { after: { 10: 'working' } }
            : {
                entry:
                  mode === 'raise'
                    ? raise({ type: 'FIRE' }, { delay: 10 })
                    : sendTo(({ self }) => self, { type: 'FIRE' }, { delay: 10 }),
                on: { FIRE: 'working' },
              }),
          on: { FIRE: 'working', CANCEL: 'idle' },
        },
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
    const actor = h.own(
      createActor(machine, { clock: h.clock, inspect: h.tracing.inspect }).start(),
    );
    const command = h.tracing.sendCommand(actor, { type: 'START' }, { name: `timer.${mode}` });
    await h.flush();
    assert.equal(actor.getSnapshot().value, 'waiting');
    assert.ok(h.has(`timer.${mode}`), 'Command already ended before timer fired');
    assert.equal((await command.finished).outcome, 'completed');
    await h.advance(10);
    assert.equal(actor.getSnapshot().value, 'done');
    assert.ok(h.calls.includes(name));
    assert.equal(h.has(name), false, 'Known gap: delayed work is untraced');
    actor.stop();
  }
  h.findings.push(
    'GAP: after, delayed raise, and delayed sendTo execute work after the command span ends; no work span is created.',
  );

  const cancelled = h.own(
    createActor(
      setup({}).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { START: 'waiting' } },
          waiting: { after: { 10: 'expired' }, on: { CANCEL: 'idle' } },
          expired: {},
        },
      }),
      { clock: h.clock, inspect: h.tracing.inspect },
    ).start(),
  );
  h.tracing.sendCommand(cancelled, { type: 'START' }, { name: 'timer.cancel.start' });
  await h.flush();
  h.tracing.sendCommand(cancelled, { type: 'CANCEL' }, { name: 'timer.cancel' });
  await h.advance(10);
  assert.equal(cancelled.getSnapshot().value, 'idle');
  h.findings.push(
    'PASS: leaving an after state cancels its timer; cancellation is a separate command.',
  );

  // Opt into native timer tracing to give delayed work a new linked operation.
  const linkedTracing = createXStateTracing({
    tracer: h.tracer,
    scheduledWorkPolicy: { mode: 'new-linked-operation', name: 'timer.linked' },
  });
  const linkedWork = linkedTracing.fromPromise<string, Record<string, never>>(
    'timer.linked.work',
    async () => {
      h.calls.push('timer.linked.work');
      return 'done';
    },
  );
  const linkedActor = h.own(
    createActor(
      setup({ actors: { linkedWork } }).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { START: 'waiting' } },
          waiting: { after: { 10: 'working' } },
          working: {
            invoke: {
              src: 'linkedWork',
              input: () => ({}),
              onDone: 'done',
            },
          },
          done: {},
        },
      }),
      { clock: h.clock, inspect: linkedTracing.inspect },
    ).start(),
  );
  const origin = linkedTracing.sendCommand(
    linkedActor,
    { type: 'START' },
    { name: 'timer.linked.origin' },
  );
  assert.equal((await origin.finished).outcome, 'completed');
  assert.equal(linkedActor.getSnapshot().value, 'waiting');
  assert.equal(h.has('timer.linked'), false);
  await h.advance(10);
  const scheduled = h.spans().find((span) => span.name === 'timer.linked');
  const workSpan = h.spans().find((span) => span.name === 'timer.linked.work');
  assert.ok(scheduled);
  assert.ok(workSpan);
  assert.equal(scheduled.links[0]?.context.spanId, origin.spanId);
  assert.notEqual(scheduled.spanContext().traceId, origin.traceId);
  assert.equal(workSpan.parentSpanContext?.spanId, scheduled.spanContext().spanId);
  assert.equal(linkedActor.getSnapshot().value, 'done');
  linkedActor.stop();
  h.findings.push(
    'PASS: optional timer integration ends the origin before the delay and parents finite work under a new linked operation.',
  );
}
