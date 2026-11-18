import { SpanStatusCode } from '@opentelemetry/api';
import { assign, setup, type AnyActorRef } from 'xstate';
import { expect, expectTypeOf, it, vi } from 'vitest';
import { XStateTracing } from '../src/index.js';
import { deferred, internals, createTestActor, useTestTracer } from './helpers.js';

const { tracer, spansNamed, spanNames, getSpan } = useTestTracer('callable-input');

it.each([false, true])(
  'passes a typed callable input unchanged and keeps its finite work attached (frozen = %s)',
  async (frozen) => {
    const tracing = new XStateTracing(tracer),
      pending = deferred<string>();
    const invocation = vi.fn();
    const task = (sku: string, quantity: number): Promise<string> => {
      invocation(sku, quantity);
      return pending.promise;
    };
    const input = frozen ? Object.freeze(task) : task;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    let child: AnyActorRef | undefined;
    let output: unknown;
    const work = tracing.fromPromise<string, typeof input>(
      'callable.work',
      async ({ input: received, self }) => {
        child = self;
        expectTypeOf(received).toEqualTypeOf<typeof input>();
        expect(received).toBe(input);
        return received('sku-1', 2);
      },
    );
    using actor = createTestActor(
      setup({ actors: { work } }).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { RUN: 'working' } },
          working: {
            invoke: {
              src: 'work',
              input: () => {
                expect(invocation).not.toHaveBeenCalled();
                return input;
              },
              onDone: {
                target: 'idle',
                actions: ({ event }) => {
                  output = event.output;
                },
              },
            },
          },
        },
      }),
      { inspect: tracing.inspect },
    ).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'callable.command' });
    let finished = false;
    void command.finished.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(invocation).toHaveBeenCalledExactlyOnceWith('sku-1', 2);
    expect(finished).toBe(false);
    pending.resolve('reservation-1');
    await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(output).toBe('reservation-1');
    expect(getSpan('callable.work').parentSpanContext?.spanId).toBe(command.spanId);
    expect(Object.getOwnPropertyDescriptors(input)).toEqual(descriptors);
    expect(internals(tracing).actorOperations.has(child!)).toBe(false);
  },
);

it('binds a callable input to a spawned Promise actor', async () => {
  const tracing = new XStateTracing(tracer);
  const input = vi.fn(async (value: number) => value * 2);
  let child: AnyActorRef | undefined;
  const work = tracing.fromPromise<number, typeof input>(
    'callable.spawn',
    async ({ input: received }) => {
      expect(received).toBe(input);
      return received(21);
    },
  );
  using actor = createTestActor(
    setup({ actors: { work } }).createMachine({
      on: {
        RUN: {
          actions: assign(({ spawn }) => {
            child = spawn(work, { input });
            return {};
          }),
        },
      },
    }),
    { inspect: tracing.inspect },
  ).start();
  const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'callable.spawn.command' });
  await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  expect(child!.getSnapshot().output).toBe(42);
  expect(input).toHaveBeenCalledExactlyOnceWith(21);
  expect(getSpan('callable.spawn').parentSpanContext?.spanId).toBe(command.spanId);
  expect(internals(tracing).actorOperations.has(child!)).toBe(false);
});

it('keeps callable business errors on the Promise error path with tracing ownership', async () => {
  const tracing = new XStateTracing(tracer),
    failure = new Error('callable service failure');
  const input = vi.fn((): number => {
    throw failure;
  });
  const work = tracing.fromPromise<number, typeof input>(
    'callable.error',
    async ({ input: received }) => received(),
  );
  let handled: unknown;
  using actor = createTestActor(
    setup({ actors: { work } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: {
          invoke: {
            src: 'work',
            input: () => input,
            onError: {
              target: 'handled',
              actions: ({ event }) => {
                handled = event.error;
              },
            },
          },
        },
        handled: {},
      },
    }),
    { inspect: tracing.inspect },
  ).start();
  const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'callable.error.command' });
  await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: true });
  expect(handled).toBe(failure);
  const span = getSpan('callable.error');
  expect(span.parentSpanContext?.spanId).toBe(command.spanId);
  expect(span.status.code).toBe(SpanStatusCode.ERROR);
});

it.each(['object', 'function'] as const)(
  'tracks both parallel Promise actors when their %s input is shared',
  async (kind) => {
    const tracing = new XStateTracing(tracer);
    const input = kind === 'object' ? {} : () => 1;
    const first = deferred<string>(),
      second = deferred<string>();
    const a = tracing.fromPromise<string, object>('shared.a', async () => first.promise);
    const b = tracing.fromPromise<string, object>('shared.b', async () => second.promise);
    using actor = createTestActor(
      setup({ actors: { a, b } }).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { RUN: 'working' } },
          working: {
            invoke: [
              { id: 'a', src: 'a', input: () => input },
              { id: 'b', src: 'b', input: () => input },
            ],
          },
        },
      }),
      { inspect: tracing.inspect },
    ).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'shared.command' });
    let finished = false;
    void command.finished.then(() => {
      finished = true;
    });
    first.resolve('first');
    // The work span ends once the Promise settles, which tracing cannot await.
    await vi.waitFor(() => expect(spanNames()).toContain('shared.a'));
    expect(finished).toBe(false);
    second.resolve('second');
    await command.finished;
    for (const name of ['shared.a', 'shared.b']) {
      expect(getSpan(name).parentSpanContext?.spanId).toBe(command.spanId);
    }
  },
);

it.each(['object', 'function'] as const)(
  'keeps reused %s inputs separate across parents and commands and preserves identity',
  async (kind) => {
    const tracing = new XStateTracing(tracer);
    const input = kind === 'object' ? Object.freeze({ value: 1 }) : Object.freeze(() => 1);
    const seen: object[] = [];
    const work = tracing.fromPromise<number, typeof input>(
      'reused.work',
      async ({ input: received }) => {
        seen.push(received);
        return typeof received === 'function' ? received() : received.value;
      },
    );
    const machine = setup({ actors: { work } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: {
          invoke: {
            src: 'work',
            input: () => input,
            onDone: 'idle',
          },
        },
      },
    });
    using a = createTestActor(machine, { inspect: tracing.inspect }).start();
    using b = createTestActor(machine, { inspect: tracing.inspect }).start();
    const commands = [
      tracing.sendCommand(a, { type: 'RUN' }, { name: 'parent.a' }),
      tracing.sendCommand(b, { type: 'RUN' }, { name: 'parent.b' }),
    ];
    await Promise.all(commands.map((command) => command.finished));
    const later = tracing.sendCommand(a, { type: 'RUN' }, { name: 'parent.later' });
    await later.finished;
    expect(seen).toEqual([input, input, input]);
    expect(seen.every((received) => received === input)).toBe(true);
    expect(spansNamed('reused.work').map((span) => span.parentSpanContext?.spanId)).toEqual(
      [...commands, later].map((command) => command.spanId),
    );
    a.stop();
  },
);

it.each(['object', 'function'] as const)(
  'selects children independently when their %s input and wrapped logic are shared',
  async (kind) => {
    const tracing = new XStateTracing(tracer);
    const input = kind === 'object' ? {} : () => 1;
    let executions = 0;
    const work = tracing.fromPromise<void, object>(
      'selective.work',
      async () => {
        executions++;
      },
      { shouldTrace: ({ self }) => self.id !== 'excluded' },
    );
    using actor = createTestActor(
      setup({ actors: { work } }).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { RUN: 'working' } },
          working: {
            invoke: [
              { id: 'included', src: 'work', input: () => input },
              { id: 'excluded', src: 'work', input: () => input },
            ],
          },
        },
      }),
      { inspect: tracing.inspect },
    ).start();
    await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'selective.command' }).finished;
    expect(executions).toBe(2);
    expect(spansNamed('selective.work')).toHaveLength(1);
  },
);
