import { createActor, setup, spawnChild, type AnyActorRef, fromCallback, waitFor } from 'xstate';
import { expect, expectTypeOf, it, vi } from 'vitest';
import { XStateTracing, type ShouldTraceArgs, type FromPromiseOptions } from '../src/index.js';
import { deferred, internals, createTestActor, useTestTracer } from './helpers.js';

const { tracer, spans, spansNamed, spanNames, getSpan } = useTestTracer('automatic-ownership');

it.each([undefined, null, false, 42, 'sku-1'])(
  'traces an invocation with unchanged primitive/absent input: %s',
  async (input) => {
    const tracing = new XStateTracing(tracer);
    const received = vi.fn();
    const work = tracing.fromPromise('primitive.work', async (args) => {
      received(args.input);
      return args.input;
    });
    using actor = createTestActor(
      setup({ actors: { work } }).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { RUN: 'working' } },
          working: { invoke: { src: 'work', input: () => input } },
        },
      }),
      { inspect: tracing.inspect },
    ).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'primitive.command' });
    await command.finished;
    expect(received).toHaveBeenCalledExactlyOnceWith(input);
    expect(getSpan('primitive.work').parentSpanContext?.spanId).toBe(command.spanId);
  },
);

it('selects two children with shared logic/input without waiting for excluded work', async () => {
  const pending = deferred<string>(),
    excluded = deferred<string>();
  const input = Object.freeze({ sku: 'sku-1' });
  const attributes = vi.fn(() => ({}));
  const tracing = new XStateTracing(tracer, { workAttributes: attributes });
  const implementation = vi.fn(({ self }: { self: AnyActorRef }) =>
    self.id === 'prefetch' ? excluded.promise : pending.promise,
  );
  const shouldTrace = vi.fn((details: ShouldTraceArgs<typeof input>) => {
    expectTypeOf(details.input).toEqualTypeOf<typeof input>();
    return details.self.id !== 'prefetch';
  });
  const work = tracing.fromPromise<string, typeof input>('selected.work', implementation, {
    attributes: { 'work.kind': 'product' },
    shouldTrace,
  });
  using actor = createTestActor(
    setup({ actors: { work } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: {
          invoke: [
            { id: 'required', src: 'work', input },
            { id: 'prefetch', src: 'work', input },
          ],
        },
      },
    }),
    { inspect: tracing.inspect },
  ).start();
  const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'selected.command' });
  let finished = false;
  void command.finished.then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(implementation).toHaveBeenCalledTimes(2);
  expect(shouldTrace).toHaveBeenCalledTimes(2);
  for (const [details] of shouldTrace.mock.calls) {
    expect(details.name).toBe('selected.work');
    expect(details.input).toBe(input);
    expect(details.parent).toBe(actor);
    expect(details.self.src).toBe('work');
  }
  pending.resolve('required done');
  await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  expect(actor.getSnapshot().children.prefetch?.getSnapshot().status).toBe('active');
  expect(attributes).toHaveBeenCalledTimes(1);
  const workSpans = spansNamed('selected.work');
  expect(workSpans).toHaveLength(1);
  expect(workSpans[0]?.attributes).toMatchObject({
    'actorium.xstate.actor.id': 'required',
    'work.kind': 'product',
  });
  excluded.resolve('prefetch done');
  // Excluded work has no span, so tracing cannot await it.
  await vi.waitFor(() =>
    expect(actor.getSnapshot().children.prefetch?.getSnapshot().status).toBe('done'),
  );
  expect(spansNamed('selected.work')).toHaveLength(1);
});

it.each(['invoke', 'spawn', 'nested'] as const)(
  'selects using parent state tags at startup after %s creation',
  async (mode) => {
    const tracing = new XStateTracing(tracer);
    const creationStates: unknown[] = [];
    const shouldTrace = vi.fn(({ self, parent }: ShouldTraceArgs<unknown>) => {
      expect(self.getSnapshot().hasTag).toBeUndefined();
      expect(parent?.getSnapshot().hasTag('background')).toBe(true);
      return false;
    });
    const work = tracing.fromPromise('tagged.work', async () => 'done', { shouldTrace });
    const nested = setup({ actors: { work } }).createMachine({
      initial: 'working',
      states: { working: { tags: 'background', invoke: { id: 'work', src: 'work' } } },
    });
    using actor = createTestActor(
      setup({ actors: { work, nested } }).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { RUN: 'working' } },
          working: {
            tags: 'background',
            ...(mode === 'spawn'
              ? { entry: spawnChild('work', { id: 'work' }) }
              : {
                  invoke: {
                    id: mode === 'nested' ? 'nested' : 'work',
                    src: mode === 'nested' ? 'nested' : 'work',
                  },
                }),
          },
        },
      }),
      {
        inspect: (inspection) => {
          tracing.inspect(inspection);
          if (
            inspection.type === '@xstate.actor' &&
            (inspection.actorRef as AnyActorRef).id === 'work'
          ) {
            const parent = (inspection.actorRef as AnyActorRef)._parent;
            try {
              creationStates.push(parent?.getSnapshot()?.value);
            } catch {
              // Development XState rejects reading an initializing parent.
              creationStates.push(undefined);
            }
          }
        },
      },
    ).start();
    await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'tagged.command' }).finished;
    expect(actor.getSnapshot().error).toBeUndefined();
    expect(creationStates).toEqual([mode === 'nested' ? undefined : 'idle']);
    expect(shouldTrace).toHaveBeenCalledTimes(1);
    expect(spans().some((span) => span.name === 'tagged.work')).toBe(false);
  },
);

const failingPolicies: readonly [string, () => unknown][] = [
  [
    'throw',
    () => {
      throw new Error('selection failed');
    },
  ],
  ['undefined', () => undefined],
  ['null', () => null],
  ['string', () => 'false'],
  ['Promise', () => Promise.resolve(false)],
];
it.each(failingPolicies)(
  'keeps tracing when shouldTrace returns/throws %s and its reporter throws',
  async (_name, policy) => {
    const diagnostic = vi.fn(() => {
      throw new Error('reporter failed');
    });
    const tracing = new XStateTracing(tracer, { onDiagnostic: diagnostic });
    const work = tracing.fromPromise('fallback.work', async () => 'done', {
      shouldTrace: policy as NonNullable<FromPromiseOptions<unknown>['shouldTrace']>,
    });
    using actor = createTestActor(
      setup({ actors: { work } }).createMachine({
        initial: 'idle',
        states: { idle: { on: { RUN: 'working' } }, working: { invoke: { src: 'work' } } },
      }),
      { inspect: tracing.inspect },
    ).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'fallback.command' });
    await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      phase: 'shouldTrace',
      error: expect.any(Error),
    });
    expect(getSpan('fallback.work').parentSpanContext?.spanId).toBe(command.spanId);
  },
);

it('does not select or trace ordinary startup work without a creating operation', async () => {
  const tracing = new XStateTracing(tracer);
  const shouldTrace = vi.fn(() => true);
  const work = tracing.fromPromise('startup.work', async () => 'done', { shouldTrace });
  using actor = createTestActor(
    setup({ actors: { work } }).createMachine({ invoke: { id: 'work', src: 'work' } }),
    {
      inspect: tracing.inspect,
    },
  ).start();
  // Startup work without a creating operation is untraced, so tracing cannot await it.
  await vi.waitFor(() =>
    expect(actor.getSnapshot().children.work?.getSnapshot().status).toBe('done'),
  );
  expect(shouldTrace).not.toHaveBeenCalled();
  expect(spans()).toHaveLength(0);
});

it('retains the creating owner when the child is started during another command', async () => {
  const tracing = new XStateTracing(tracer);
  const blocker = deferred<string>(),
    pending = deferred<string>();
  const block = tracing.fromPromise('origin.block', () => blocker.promise);
  const grandchild = tracing.fromPromise('late.nested.work', () => pending.promise);
  const work = tracing.fromPromise('late.work', ({ self }) => {
    createActor(grandchild, { parent: self }).start();
    return pending.promise;
  });
  let child: ReturnType<typeof createActor<typeof work>>;
  using actor = createTestActor(
    setup({ actors: { block } }).createMachine({
      on: {
        CREATE: {
          actions: [
            spawnChild('block'),
            ({ self }) => {
              child = createActor(work, { parent: self });
            },
          ],
        },
        START: { actions: () => child.start() },
      },
    }),
    { inspect: tracing.inspect },
  ).start();
  const origin = tracing.sendCommand(actor, { type: 'CREATE' }, { name: 'origin.command' });
  let originFinished = false;
  void origin.finished.then(() => {
    originFinished = true;
  });
  await tracing.sendCommand(actor, { type: 'START' }, { name: 'later.command' }).finished;
  blocker.resolve('done');
  await tracing.waitForBookkeeping();
  expect(spanNames()).toContain('origin.block');
  expect(originFinished).toBe(false);
  pending.resolve('done');
  await origin.finished;
  expect(getSpan('late.work').parentSpanContext?.spanId).toBe(origin.spanId);
  expect(getSpan('late.nested.work').parentSpanContext?.spanId).toBe(origin.spanId);
});

it('clears an unstarted child association when its creating operation ends', async () => {
  const tracing = new XStateTracing(tracer);
  const shouldTrace = vi.fn(() => true);
  const work = tracing.fromPromise('expired.work', async () => 'done', { shouldTrace });
  let child: ReturnType<typeof createActor<typeof work>>;
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        CREATE: {
          actions: ({ self }) => {
            child = createActor(work, { parent: self });
          },
        },
        START: { actions: () => child.start() },
      },
    }),
    { inspect: tracing.inspect },
  ).start();
  await tracing.sendCommand(actor, { type: 'CREATE' }, { name: 'expired.command' }).finished;
  expect(internals(tracing).actorOperations.has(child!)).toBe(false);
  await tracing.sendCommand(actor, { type: 'START' }, { name: 'newer.command' }).finished;
  await waitFor(child!, (snapshot) => snapshot.status === 'done');
  expect(shouldTrace).not.toHaveBeenCalled();
  expect(spans().map((span) => span.name)).toEqual(['expired.command', 'newer.command']);
});

it('preserves Promise actor system and typed emitted events', async () => {
  const tracing = new XStateTracing(tracer);
  const work = tracing.fromPromise<string, object, { type: 'progress'; step: number }>(
    'api.work',
    async ({ system, self, emit }) => {
      expect(system).toBe(self.system);
      emit({ type: 'progress', step: 1 });
      return 'done';
    },
  );
  using actor = createTestActor(work, { input: {}, inspect: tracing.inspect });
  const receive = vi.fn();
  actor.on('progress', receive);
  actor.start();
  await waitFor(actor, (snapshot) => snapshot.status === 'done');
  expect(receive).toHaveBeenCalledWith({ type: 'progress', step: 1 });
  expect(spans()).toHaveLength(0);
});

it.each(['object', 'function'] as const)(
  'removes %s invocation ownership when an always transition cancels startup',
  async (kind) => {
    const tracing = new XStateTracing(tracer);
    const input = kind === 'object' ? {} : () => 1;
    const implementation = vi.fn(async () => 'done');
    const work = tracing.fromPromise<string, object>('transient.work', implementation);
    let child: object | undefined;
    using actor = createTestActor(
      setup({ actors: { work } }).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { RUN: 'transient' } },
          transient: {
            invoke: {
              id: 'work',
              src: 'work',
              input: () => input,
            },
            always: 'idle',
          },
        },
      }),
      {
        inspect: (inspection) => {
          tracing.inspect(inspection);
          if (
            inspection.type === '@xstate.actor' &&
            (inspection.actorRef as AnyActorRef).id === 'work'
          )
            child = inspection.actorRef;
        },
      },
    ).start();
    await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'transient.command' }).finished;
    expect(implementation).not.toHaveBeenCalled();
    expect(child).toBeDefined();
    expect(internals(tracing).actorOperations.has(child!)).toBe(false);
  },
);

it('keeps a child error handoff open for replacement traced work', async () => {
  const tracing = new XStateTracing(tracer),
    pending = deferred<string>();
  const work = tracing.fromPromise<string, object>('recovery.work', async () => pending.promise);
  const child = fromCallback(() => {
    throw new Error('child failed');
  });
  using actor = createTestActor(
    setup({ actors: { child, work } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'child' } },
        child: { invoke: { src: 'child', onError: 'recovery' } },
        recovery: {
          invoke: {
            src: 'work',
            input: () => ({}),
            onDone: 'idle',
          },
        },
      },
    }),
    { inspect: tracing.inspect },
  ).start();
  const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'recovery.command' });
  await Promise.resolve();
  expect(spansNamed('recovery.command')).toEqual([]);
  pending.resolve('done');
  await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: true });
  expect(getSpan('recovery.work').parentSpanContext?.spanId).toBe(command.spanId);
});
