import assert from 'node:assert/strict';
import { createActor, fromCallback, sendTo, setup } from 'xstate';
import { XStateTracing, type TelemetryDiagnostic } from '../../src/index.js';
import type { Harness } from './harness.js';

export async function invokedExample(h: Harness) {
  const child = setup({ actors: { work: h.work('invoked.nested.work') } }).createMachine({
    initial: 'working',
    states: {
      working: {
        invoke: {
          src: 'work',
          input: () => ({}),
          onDone: 'done',
        },
      },
      done: { type: 'final' },
    },
  });
  const parent = setup({ actors: { child, followup: h.work('invoked.followup') } }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { START: 'child' } },
      child: { invoke: { src: 'child', onDone: 'followup' } },
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
  const command = h.tracing.sendCommand(actor, { type: 'START' }, { name: 'invoked.start' });
  await h.flush();
  assert.equal(actor.getSnapshot().value, 'done');
  h.child('invoked.nested.work', command);
  h.child('invoked.followup', command);
  h.findings.push(
    'PASS: nested invoked machine → traced Promise → parent onDone → traced Promise stays in one operation.',
  );
  h.findings.push(
    'LIMIT: invoked machines have no own span or work registration; only their wrapped Promise work keeps the operation open. Initialization relies on XState _parent.',
  );

  const load = Object.freeze(async (sku: string) => {
    h.calls.push('invoked.callable.work');
    return `loaded:${sku}`;
  });
  const callableWork = h.tracing.fromPromise<string, typeof load>(
    'invoked.callable.work',
    async ({ input }) => {
      assert.equal(input, load);
      return input('sku-1');
    },
  );
  let callableOutput: string | undefined;
  const callable = h.own(
    createActor(
      setup({ actors: { callableWork } }).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { START: 'working' } },
          working: {
            invoke: {
              src: 'callableWork',
              input: () => load,
              onDone: {
                target: 'done',
                actions: ({ event }) => {
                  callableOutput = event.output;
                },
              },
            },
          },
          done: {},
        },
      }),
      { inspect: h.tracing.inspect },
    ).start(),
  );
  const callableCommand = h.tracing.sendCommand(
    callable,
    { type: 'START' },
    { name: 'invoked.callable.start' },
  );
  await callableCommand.finished;
  assert.equal(callableOutput, 'loaded:sku-1');
  h.child('invoked.callable.work', callableCommand);
  h.findings.push(
    'PASS: a frozen function input reaches its Promise actor unchanged and its finite work belongs to the command.',
  );

  // Models a socket/subscription delivering a result in a later callback.
  let respond: (() => void) | undefined;
  let disposed = false;
  const callback = fromCallback(({ sendBack }) => {
    respond = () => sendBack({ type: 'RESULT' });
    return () => {
      disposed = true;
    };
  });
  const callbackMachine = setup({
    actors: { callback, work: h.work('invoked.callback.work') },
  }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { START: 'listening' } },
      listening: { invoke: { src: 'callback' }, on: { RESULT: 'working' } },
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
  const listener = h.own(createActor(callbackMachine, { inspect: h.tracing.inspect }).start());
  h.tracing.sendCommand(listener, { type: 'START' }, { name: 'invoked.callback.start' });
  await h.flush();
  assert.ok(h.has('invoked.callback.start'));
  assert.ok(respond);
  respond();
  await h.flush();
  assert.equal(listener.getSnapshot().value, 'done');
  assert.equal(disposed, true);
  assert.ok(h.calls.includes('invoked.callback.work'));
  assert.equal(h.has('invoked.callback.work'), false);
  h.findings.push(
    'GAP: a callback actor reply sent from a later callback has no operation; work started by its sendBack is untraced. Its cleanup still runs normally.',
  );

  const startupWorker = setup({ actors: { work: h.work('prestart.startup.work') } }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { STARTUP: 'working' } },
      working: {
        invoke: {
          src: 'work',
          input: () => ({}),
          onDone: 'idle',
        },
      },
    },
  });
  const prestart = h.own(
    createActor(
      setup({
        actors: { startupWorker, commandWork: h.work('prestart.command.work') },
      }).createMachine({
        invoke: { id: 'startupWorker', src: 'startupWorker' },
        entry: sendTo('startupWorker', { type: 'STARTUP' }),
        initial: 'idle',
        states: {
          idle: { on: { RUN: 'working' } },
          working: {
            invoke: {
              src: 'commandWork',
              input: () => ({}),
              onDone: 'done',
            },
          },
          done: {},
        },
      }),
      { inspect: h.tracing.inspect },
    ),
  );
  const queued = h.tracing.sendCommand(prestart, { type: 'RUN' }, { name: 'prestart.command' });
  prestart.start();
  await h.flush();
  assert.equal((await queued.finished).outcome, 'completed');
  assert.equal(prestart.getSnapshot().value, 'done');
  assert.ok(h.calls.includes('prestart.startup.work'));
  assert.equal(h.has('prestart.startup.work'), false);
  h.child('prestart.command.work', queued);
  h.findings.push(
    'PASS: a pre-start command owns its finite work while unrelated startup relays remain untraced.',
  );

  const diagnostics: TelemetryDiagnostic[] = [];
  const errorTracing = new XStateTracing(h.tracer, {
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const failure = new Error('untraced root failure');
  const applicationErrors: unknown[] = [];
  const failing = h.own(
    createActor(
      setup({}).createMachine({
        on: {
          FAIL: {
            actions: () => {
              throw failure;
            },
          },
        },
      }),
      { inspect: errorTracing.inspect },
    ),
  );
  failing.subscribe({ error: (error) => applicationErrors.push(error) });
  failing.start();
  const spanCount = h.spans().length;
  failing.send({ type: 'FAIL' });
  assert.equal(failing.getSnapshot().error, failure);
  await Promise.resolve();
  assert.deepEqual(diagnostics, [{ phase: 'unassociatedRootError', error: failure }]);
  assert.deepEqual(applicationErrors, [failure]);
  assert.equal(h.spans().length, spanCount);
  h.findings.push(
    'PASS: an untraced root failure reports its original error to diagnostics and application observers without creating a span.',
  );
}
