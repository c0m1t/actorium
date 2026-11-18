import assert from 'node:assert/strict';
import { createActor, setup } from 'xstate';
import type { Harness } from './harness.js';

export async function longRunningExample(h: Harness) {
  const machine = setup({
    actors: {
      load: h.work('workflow.load'),
      save: h.work('workflow.save'),
      finish: h.work('workflow.finish'),
    },
  }).createMachine({
    initial: 'awaitingStart',
    states: {
      awaitingStart: { on: { START: 'validating' } },
      validating: { always: 'loading' },
      loading: {
        invoke: {
          src: 'load',
          input: () => ({}),
          onDone: 'awaitingDetails',
        },
      },
      awaitingDetails: { on: { DETAILS: 'debouncing' } },
      debouncing: { after: { 100: 'saving' } },
      saving: {
        invoke: {
          src: 'save',
          input: () => ({}),
          onDone: 'awaitingApproval',
        },
      },
      awaitingApproval: { on: { APPROVE: 'checking' } },
      checking: { always: 'finishing' },
      finishing: {
        invoke: {
          src: 'finish',
          input: () => ({}),
          onDone: 'complete',
        },
      },
      complete: {},
    },
  });
  const actor = h.own(createActor(machine, { inspect: h.tracing.inspect, clock: h.clock }).start());
  const start = h.tracing.sendCommand(actor, { type: 'START' }, { name: 'workflow.start' });
  await h.flush();
  assert.equal(actor.getSnapshot().value, 'awaitingDetails');
  h.child('workflow.load', start);
  assert.ok(h.has('workflow.start'));
  await h.advance(60_000); // Simulated user think time, no wall-clock wait.
  const details = h.tracing.sendCommand(actor, { type: 'DETAILS' }, { name: 'workflow.details' });
  await h.flush();
  assert.equal(actor.getSnapshot().value, 'debouncing');
  assert.ok(h.has('workflow.details'));
  await h.advance(100);
  assert.equal(actor.getSnapshot().value, 'awaitingApproval');
  assert.ok(h.calls.includes('workflow.save'));
  assert.equal(h.has('workflow.save'), false);
  await h.advance(60_000);
  const approve = h.tracing.sendCommand(actor, { type: 'APPROVE' }, { name: 'workflow.approve' });
  await h.flush();
  h.child('workflow.finish', approve);
  assert.equal(actor.getSnapshot().value, 'complete');
  assert.equal(actor.getSnapshot().status, 'active');
  assert.equal(new Set([start.traceId, details.traceId, approve.traceId]).size, 3);
  h.findings.push(
    'PASS: one persistent actor, three commands/traces, two user waits, always transitions, and async work without tracing user think time.',
  );
  h.findings.push(
    'GAP: async save after the debounce delay runs successfully but has no work span; DETAILS finishes before save begins.',
  );
}
