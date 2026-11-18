import { raise, sendTo, setup, SimulatedClock, stopChild } from 'xstate';
import { expect, it } from 'vitest';
import {
  getAttributeKeys,
  createXStateTracing,
  DEFAULT_ATTRIBUTE_NAMESPACE,
  XStateTracing,
} from '../src/index.js';
import { expectStoppedActorWarnings, createTestActor, useTestTracer } from './helpers.js';

const { tracer, spans, spanNames, getSpan } = useTestTracer('attribute-namespace');

it('emits every name under the configured namespace, and only names from the table', async () => {
  const namespace = 'acme.workflows';
  const tracing = new XStateTracing(tracer, {
    attributeNamespace: namespace,
    recordMicrosteps: true,
    scheduledWorkPolicy: { mode: 'new-linked-operation' },
  });
  const ok = tracing.fromPromise<string, object>('work.ok', async () => 'done');
  // No message or stack: exercises the unavailable-details marker.
  const failing = tracing.fromPromise<string, object>('work.failing', async () => {
    throw {};
  });
  const pending = tracing.fromPromise<string, object>('work.pending', () => new Promise(() => {}));
  const worker = setup({}).createMachine({});
  const machine = setup({ actors: { ok, failing, pending, worker } }).createMachine({
    context: ({ spawn }) => ({ worker: spawn('worker', { id: 'worker' }) }),
    initial: 'idle',
    on: { TICK: {} },
    states: {
      idle: {
        on: {
          RUN: 'running',
          FAIL: 'failing',
          WAIT: 'waiting',
          LATER: { actions: raise({ type: 'TICK' }, { delay: 10 }) },
          DROP: {
            actions: [
              stopChild(({ context }) => context.worker),
              sendTo(({ context }) => context.worker, { type: 'WORK' }),
            ],
          },
        },
      },
      running: { invoke: { src: 'ok', input: () => ({}), onDone: 'idle' } },
      failing: { invoke: { src: 'failing', input: () => ({}), onError: 'idle' } },
      waiting: { invoke: { src: 'pending', input: () => ({}) }, on: { CANCEL: 'idle' } },
    },
  });
  const clock = new SimulatedClock();
  using actor = createTestActor(machine, { inspect: tracing.inspect, clock }).start();
  const child = actor.getSnapshot().context.worker;
  const send = (type: string, name: string) =>
    tracing.sendCommand(actor, { type }, { name, attributes: { 'app.request': name } });

  await send('RUN', 'run').finished;
  await send('FAIL', 'fail').finished;
  const waiting = send('WAIT', 'wait');
  await send('CANCEL', 'cancel').finished;
  await waiting.finished;
  await send('LATER', 'later').finished;
  clock.increment(10);
  await tracing.settle();
  expect(spanNames()).toContain(`${namespace}.scheduled`);
  await expectStoppedActorWarnings(child, ['WORK'], () => send('DROP', 'drop')).finished;
  actor.stop();

  const applicationNames = new Set(['run', 'fail', 'wait', 'cancel', 'later', 'drop']);
  applicationNames.add('work.ok').add('work.failing').add('work.pending').add('app.request');
  const emitted = new Set<string>();
  for (const span of spans()) {
    emitted.add(span.name);
    for (const key of Object.keys(span.attributes)) emitted.add(key);
    for (const event of span.events) {
      emitted.add(event.name);
      for (const key of Object.keys(event.attributes ?? {})) emitted.add(key);
    }
  }
  const namespaced = [...emitted].filter((name) => name.startsWith(`${namespace}.`));
  const unexpected = [...emitted].filter(
    (name) =>
      !name.startsWith(`${namespace}.`) &&
      !applicationNames.has(name) &&
      name !== 'exception' &&
      !name.startsWith('exception.'),
  );
  expect(unexpected).toEqual([]);
  expect(namespaced.sort()).toEqual(Object.values(getAttributeKeys(namespace)).sort());
});

it('defaults to the actorium.xstate namespace', async () => {
  expect(DEFAULT_ATTRIBUTE_NAMESPACE).toBe('actorium.xstate');
  const keys = getAttributeKeys();
  expect(keys.operationOutcome).toBe('actorium.xstate.operation.outcome');
  expect(keys.scheduledSpan).toBe('actorium.xstate.scheduled');
  expect(Object.isFrozen(keys)).toBe(true);
  expect(new Set(Object.values(keys)).size).toBe(Object.keys(keys).length);

  const tracing = new XStateTracing(tracer);
  using actor = createTestActor(setup({}).createMachine({}), { inspect: tracing.inspect }).start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'default' }).finished;
  expect(spans()[0]?.attributes[keys.operationOutcome]).toBe('completed');
});

it('keeps full-key overrides ahead of the namespace', async () => {
  const tracing = new XStateTracing(tracer, {
    attributeNamespace: 'acme',
    actorIdAttribute: 'app.actor',
    detailsUnavailableAttribute: 'app.details_missing',
  });
  const failing = tracing.fromPromise<string, object>('work', async () => {
    throw {};
  });
  using actor = createTestActor(
    setup({ actors: { failing } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: { invoke: { id: 'job', src: 'failing', input: () => ({}), onError: 'idle' } },
      },
    }),
    { inspect: tracing.inspect },
  ).start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'command' }).finished;
  const work = getSpan('work');
  expect(work.attributes).toMatchObject({ 'app.actor': 'job', 'app.details_missing': true });
  expect(work.attributes['acme.actor.id']).toBeUndefined();
  expect(work.attributes['acme.error.details_unavailable']).toBeUndefined();
});

it.each(['', 'Acme', 'acme.', '.acme', 'acme..workflows', 'acme-workflows', 'acme.Flows', '1acme'])(
  'rejects the invalid namespace %j at construction',
  (attributeNamespace) => {
    expect(() => new XStateTracing(tracer, { attributeNamespace })).toThrow(TypeError);
    expect(() => createXStateTracing({ tracer, attributeNamespace })).toThrow(
      /Invalid attributeNamespace/,
    );
    expect(() => getAttributeKeys(attributeNamespace)).toThrow(TypeError);
  },
);

it.each(['acme', 'acme.workflows', 'a1_b.c2'])('accepts the namespace %j', (attributeNamespace) => {
  expect(getAttributeKeys(attributeNamespace).operationId).toBe(
    `${attributeNamespace}.operation.id`,
  );
  expect(() => new XStateTracing(tracer, { attributeNamespace })).not.toThrow();
});
