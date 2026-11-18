import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { assign, createActor, raise, setup, type AnyActorRef, waitFor } from 'xstate';
import { describe, expect, it, vi } from 'vitest';
import { createCheckout } from './fixtures/checkout/create-checkout.js';
import type { Basket, CheckoutServices, Product } from './fixtures/checkout/checkout.machine.js';
import { XStateTracing, createXStateTracing } from '../src/index.js';
import { deferred, createTestActor, useTestTracer } from './helpers.js';

const { tracer, spansNamed, spanNames, getSpan } = useTestTracer('xstate-tracing', {
  contextManager: true,
});

describe('commands', () => {
  it('exposes a configurable library factory and awaitable command handle', async () => {
    const tracing = createXStateTracing({
      tracer,
      recordMicrosteps: true,
      recordStateValues: false,
      actorIdAttribute: false,
      operationSpanKind: SpanKind.SERVER,
      commonAttributes: { 'library.name': 'demo' },
      operationAttributes: ({ event }) => ({
        'library.event': event.type,
      }),
    });
    const machine = setup({
      types: { events: {} as { type: 'RUN' } },
      actions: {
        syncWork: ({ self }) => {
          tracing.withActiveOperation(self, () => {
            tracer.startActiveSpan('sync.work', (span) => span.end());
          });
        },
      },
    }).createMachine({
      on: { RUN: { actions: 'syncWork' } },
    });
    using actor = createTestActor(machine, { inspect: tracing.inspect }).start();

    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'library.run' });
    const result = await command.finished;
    const operation = getSpan('library.run');
    const work = getSpan('sync.work');

    expect(result).toEqual({ outcome: 'completed', hadError: false });
    expect(command.traceId).toBe(operation.spanContext().traceId);
    expect(command.spanId).toBe(operation.spanContext().spanId);
    expect(operation.kind).toBe(SpanKind.SERVER);
    expect(operation.attributes['library.name']).toBe('demo');
    expect(operation.attributes['library.event']).toBe('RUN');
    expect(work.parentSpanContext?.spanId).toBe(command.spanId);
    expect(operation.events[0]?.attributes?.['actorium.xstate.actor.id']).toBeUndefined();
    expect(operation.events[0]?.attributes?.['actorium.xstate.state.value']).toBeUndefined();
  });

  it('reports handled Promise failures through the command handle', async () => {
    const tracing = createXStateTracing({ tracer });
    const failingWork = tracing.fromPromise<never, Record<string, never>>(
      'library.failing_work',
      async () => {
        throw new Error('expected failure');
      },
    );
    const machine = setup({
      types: { events: {} as { type: 'RUN' } },
      actors: { failingWork },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: {
          invoke: {
            src: 'failingWork',
            input: () => ({}),
            onError: 'failed',
          },
        },
        failed: {},
      },
    });
    using actor = createTestActor(machine, { inspect: tracing.inspect }).start();

    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'library.failure' });

    await expect(command.finished).resolves.toEqual({
      outcome: 'completed',
      hadError: true,
    });
    expect(getSpan('library.failing_work').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('marks root action failures as failed operations by default', async () => {
    const diagnostic = vi.fn();
    const tracing = new XStateTracing(tracer, { onTelemetryError: diagnostic });
    const machine = setup({
      types: { events: {} as { type: 'RUN' } },
      actions: {
        throwFailure: () => {
          throw new Error('root action failed');
        },
      },
    }).createMachine({
      on: { RUN: { actions: 'throwFailure' } },
    });
    using actor = createTestActor(machine, { inspect: tracing.inspect });
    const onError = vi.fn();
    actor.subscribe({ error: onError });
    actor.start();

    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'root.action_failure' });

    await expect(command.finished).resolves.toEqual({
      outcome: 'failed',
      hadError: true,
    });
    const span = getSpan('root.action_failure');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['actorium.xstate.operation.outcome']).toBe('failed');
    expect(span.attributes['actorium.xstate.operation.had_error']).toBe(true);
    expect(span.attributes['actorium.xstate.operation.error_count']).toBe(1);
    expect(span.events.some((event) => event.name === 'exception')).toBe(true);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      phase: 'associatedRootError',
      error: actor.getSnapshot().error,
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(actor.getSnapshot().error);
  });

  it('marks root guard failures as failed operations', async () => {
    const diagnostic = vi.fn();
    const tracing = new XStateTracing(tracer, { onTelemetryError: diagnostic });
    const machine = setup({
      types: { events: {} as { type: 'RUN' } },
      guards: {
        throwFailure: () => {
          throw new Error('root guard failed');
        },
      },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            RUN: { guard: 'throwFailure', target: 'done' },
          },
        },
        done: {},
      },
    });
    using actor = createTestActor(machine, { inspect: tracing.inspect });
    const onError = vi.fn();
    actor.subscribe({ error: onError });
    actor.start();

    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'root.guard_failure' });

    await expect(command.finished).resolves.toEqual({
      outcome: 'failed',
      hadError: true,
    });
    expect(getSpan('root.guard_failure').status.code).toBe(SpanStatusCode.ERROR);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      phase: 'associatedRootError',
      error: actor.getSnapshot().error,
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(actor.getSnapshot().error);
  });

  it('fails the command that errors and cancels deliveries queued behind it', async () => {
    const diagnostic = vi.fn();
    const tracing = new XStateTracing(tracer, { onTelemetryError: diagnostic });
    let actor!: AnyActorRef;
    let queuedCommand!: ReturnType<typeof tracing.sendCommand>;
    const machine = setup({
      types: {
        events: {} as { type: 'FAIL' } | { type: 'QUEUED' },
      },
      actions: {
        enqueueThenThrow: () => {
          queuedCommand = tracing.sendCommand(
            actor,
            { type: 'QUEUED' },
            { name: 'root.queued_after_failure' },
          );
          throw new Error('failure with queued delivery');
        },
      },
    }).createMachine({
      on: { FAIL: { actions: 'enqueueThenThrow' } },
    });
    actor = createActor(machine, { inspect: tracing.inspect });
    const onError = vi.fn();
    actor.subscribe({ error: onError });
    actor.start();

    const failedCommand = tracing.sendCommand(
      actor,
      { type: 'FAIL' },
      { name: 'root.failure_with_queue' },
    );

    await expect(failedCommand.finished).resolves.toEqual({
      outcome: 'failed',
      hadError: true,
    });
    await expect(queuedCommand.finished).resolves.toEqual({
      outcome: 'cancelled',
      hadError: false,
    });
    expect(getSpan('root.failure_with_queue').attributes['actorium.xstate.operation.outcome']).toBe(
      'failed',
    );
    expect(
      getSpan('root.queued_after_failure').attributes['actorium.xstate.operation.outcome'],
    ).toBe('cancelled');
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      phase: 'associatedRootError',
      error: actor.getSnapshot().error,
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(actor.getSnapshot().error);
  });

  it('ends a command as dropped when it is sent to a stopped actor', () => {
    const tracing = new XStateTracing(tracer);
    using actor = createTestActor(
      setup({
        types: { events: {} as { type: 'PING' } },
      }).createMachine({}),
      { inspect: tracing.inspect },
    ).start();

    actor.stop();
    tracing.sendCommand(actor, { type: 'PING' }, { name: 'command.ping' });

    expect(getSpan('command.ping').attributes['actorium.xstate.operation.outcome']).toBe('dropped');
  });

  it('handles a command queued before actor.start()', async () => {
    const tracing = new XStateTracing(tracer, { recordMicrosteps: true });
    const machine = setup({
      types: { events: {} as { type: 'PING' } },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { PING: 'done' } },
        done: {},
      },
    });
    using actor = createTestActor(machine, { inspect: tracing.inspect });

    tracing.sendCommand(actor, { type: 'PING' }, { name: 'command.prestart' });
    expect(spanNames()).not.toContain('command.prestart');

    actor.start();
    await tracing.settle();
    expect(spanNames()).toContain('command.prestart');

    expect(actor.getSnapshot().matches('done')).toBe(true);
    expect(getSpan('command.prestart').attributes['actorium.xstate.operation.outcome']).toBe(
      'completed',
    );
  });
});

describe('checkout workflow', () => {
  it('keeps one semantic operation across product lookup and basket add', async () => {
    const product = deferred<Product>();
    const basket = deferred<Basket>();

    const services: CheckoutServices = {
      loadProduct: () => product.promise,
      addProduct: () => basket.promise,
    };

    using checkout = createCheckout({
      workflowId: 'checkout-1',
      tracer,
      services,
      recordMicrosteps: true,
    });
    const { actor, tracing } = checkout;

    tracing.sendCommand(
      actor,
      { type: 'ADD_ITEM', barcode: '123' },
      {
        name: 'checkout.add_item',
        attributes: { 'workflow.id': 'checkout-1' },
      },
    );

    expect(actor.getSnapshot().matches('loadingProduct')).toBe(true);
    expect(spanNames()).not.toContain('checkout.add_item');

    product.resolve({ id: 'P1', requiresRescan: false });

    await waitFor(actor, (snapshot) => snapshot.matches('addingProduct'));
    expect(spanNames()).toContain('product.lookup');
    expect(spanNames()).not.toContain('checkout.add_item');

    basket.resolve({ id: 'B1', itemCount: 1 });

    await waitFor(actor, (snapshot) => snapshot.matches('ready'));
    await tracing.settle();
    expect(spanNames()).toContain('checkout.add_item');

    const operation = getSpan('checkout.add_item');
    const productSpan = getSpan('product.lookup');
    const basketSpan = getSpan('basket.add_item');

    expect(operation.attributes['actorium.xstate.operation.outcome']).toBe('completed');
    expect(operation.attributes['workflow.id']).toBe('checkout-1');

    // Both finite invokes are direct children of the semantic operation.
    expect(productSpan.spanContext().traceId).toBe(operation.spanContext().traceId);
    expect(basketSpan.spanContext().traceId).toBe(operation.spanContext().traceId);
    expect(productSpan.parentSpanContext?.spanId).toBe(operation.spanContext().spanId);
    expect(basketSpan.parentSpanContext?.spanId).toBe(operation.spanContext().spanId);

    expect(operation.events.some((event) => event.name === 'actorium.xstate.microstep')).toBe(true);
  });

  it('ends automatically when product resolution settles in passive waitingForRescan', async () => {
    const product = deferred<Product>();
    let addCalls = 0;

    const services: CheckoutServices = {
      loadProduct: () => product.promise,
      addProduct: async () => {
        addCalls += 1;
        return { id: 'B1', itemCount: 1 };
      },
    };

    using checkout = createCheckout({
      workflowId: 'checkout-2',
      tracer,
      services,
    });
    const { actor, tracing } = checkout;

    tracing.sendCommand(actor, { type: 'ADD_ITEM', barcode: '123' }, { name: 'checkout.add_item' });

    product.resolve({ id: 'P1', requiresRescan: true });

    await waitFor(actor, (snapshot) => snapshot.matches('waitingForRescan'));
    await tracing.settle();
    expect(spanNames()).toContain('checkout.add_item');

    expect(addCalls).toBe(0);
    expect(getSpan('checkout.add_item').attributes['actorium.xstate.operation.outcome']).toBe(
      'completed',
    );
    expect(spanNames()).toEqual(expect.arrayContaining(['product.lookup', 'checkout.add_item']));
    expect(spanNames()).not.toContain('basket.add_item');
  });

  it('starts a new operation for RESCAN instead of holding a trace open while waiting', async () => {
    const firstProduct = deferred<Product>();
    const secondProduct = deferred<Product>();
    const basket = deferred<Basket>();
    let loadCount = 0;

    const services: CheckoutServices = {
      loadProduct: () => {
        loadCount += 1;
        return loadCount === 1 ? firstProduct.promise : secondProduct.promise;
      },
      addProduct: () => basket.promise,
    };

    using checkout = createCheckout({
      workflowId: 'checkout-3',
      tracer,
      services,
    });
    const { actor, tracing } = checkout;

    tracing.sendCommand(
      actor,
      { type: 'ADD_ITEM', barcode: 'first' },
      { name: 'checkout.add_item' },
    );

    firstProduct.resolve({ id: 'P1', requiresRescan: true });
    await waitFor(actor, (snapshot) => snapshot.matches('waitingForRescan'));
    await tracing.settle();
    expect(spansNamed('checkout.add_item')).toHaveLength(1);

    tracing.sendCommand(
      actor,
      { type: 'RESCAN', barcode: 'second' },
      { name: 'checkout.rescan_item' },
    );

    secondProduct.resolve({ id: 'P1', requiresRescan: false });
    await waitFor(actor, (snapshot) => snapshot.matches('addingProduct'));

    basket.resolve({ id: 'B1', itemCount: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches('ready'));
    await tracing.settle();
    expect(spansNamed('checkout.rescan_item')).toHaveLength(1);

    const firstOperation = getSpan('checkout.add_item');
    const secondOperation = getSpan('checkout.rescan_item');

    // Separate user interactions => separate traces.
    expect(firstOperation.spanContext().traceId).not.toBe(secondOperation.spanContext().traceId);
  });

  it('cancels the in-flight finite invoke when another command exits its invoking state', async () => {
    const product = deferred<Product>();
    let observedSignal: AbortSignal | undefined;

    const services: CheckoutServices = {
      loadProduct: (_barcode, signal) => {
        observedSignal = signal;
        return new Promise<Product>((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
          product.promise.then(resolve, reject);
        });
      },
      addProduct: async () => ({ id: 'B1', itemCount: 1 }),
    };

    using checkout = createCheckout({
      workflowId: 'checkout-4',
      tracer,
      services,
    });
    const { actor, tracing } = checkout;

    const addCommand = tracing.sendCommand(
      actor,
      { type: 'ADD_ITEM', barcode: '123' },
      { name: 'checkout.add_item' },
    );

    expect(actor.getSnapshot().matches('loadingProduct')).toBe(true);
    expect(observedSignal?.aborted).toBe(false);

    const cancelCommand = tracing.sendCommand(
      actor,
      { type: 'CANCEL' },
      { name: 'checkout.cancel' },
    );

    expect(actor.getSnapshot().matches('idle')).toBe(true);
    expect(observedSignal?.aborted).toBe(true);

    await tracing.settle();
    expect(spansNamed('checkout.add_item')).toHaveLength(1);
    await tracing.settle();
    expect(spansNamed('checkout.cancel')).toHaveLength(1);

    expect(getSpan('checkout.add_item').attributes['actorium.xstate.operation.outcome']).toBe(
      'cancelled',
    );
    expect(getSpan('checkout.cancel').attributes['actorium.xstate.operation.outcome']).toBe(
      'completed',
    );
    await expect(addCommand.finished).resolves.toEqual({
      outcome: 'cancelled',
      hadError: false,
    });
    await expect(cancelCommand.finished).resolves.toEqual({
      outcome: 'completed',
      hadError: false,
    });
  });
});

describe('mailbox', () => {
  it('mirrors untraced mailbox entries so they cannot inherit a later command', async () => {
    const work = deferred<string>();
    const tracing = new XStateTracing(tracer);
    const backgroundWork = tracing.fromPromise<string, Record<string, never>>(
      'background.b',
      () => work.promise,
    );

    let actor!: AnyActorRef;
    const machine = setup({
      types: {
        context: {} as Record<string, never>,
        events: {} as { type: 'A' } | { type: 'B' } | { type: 'C' },
      },
      actors: { backgroundWork },
      actions: {
        enqueueBThenC: () => {
          // These are re-entrant sends, so both deliveries occupy the mailbox
          // before A's processing turn emits its snapshot. B is deliberately
          // not a telemetry command; C is.
          actor.send({ type: 'B' });
          tracing.sendCommand(actor, { type: 'C' }, { name: 'command.c' });
        },
      },
    }).createMachine({
      context: {},
      initial: 'idle',
      states: {
        idle: {
          on: {
            A: { actions: 'enqueueBThenC' },
            B: 'runningB',
          },
        },
        runningB: {
          invoke: {
            src: 'backgroundWork',
            input: () => ({}),
            onDone: 'done',
          },
        },
        done: {},
      },
    });

    actor = createActor(machine, { inspect: tracing.inspect }).start();

    tracing.sendCommand(actor, { type: 'A' }, { name: 'command.a' });

    expect(actor.getSnapshot().matches('runningB')).toBe(true);
    await tracing.settle();
    expect(spanNames()).toContain('command.c');

    // Incorrect mailbox ownership would let B inherit C and
    // background.b became C's child, keeping command.c open until B settled.
    expect(spanNames()).not.toContain('background.b');
    expect(getSpan('command.c').attributes['actorium.xstate.operation.outcome']).toBe('completed');

    work.resolve('done');
    await waitFor(actor, (snapshot) => snapshot.matches('done'));
    expect(spanNames()).not.toContain('background.b');

    actor.stop();
  });

  it('cancels a traced delivery abandoned when its actor reaches a final state', async () => {
    const tracing = new XStateTracing(tracer);
    let actor!: AnyActorRef;
    const machine = setup({
      types: {
        events: {} as { type: 'FINISH' } | { type: 'TOO_LATE' },
      },
      actions: {
        enqueueAfterFinish: () => {
          tracing.sendCommand(actor, { type: 'TOO_LATE' }, { name: 'command.too_late' });
        },
      },
    }).createMachine({
      initial: 'active',
      states: {
        active: {
          on: {
            FINISH: {
              target: 'done',
              actions: 'enqueueAfterFinish',
            },
          },
        },
        done: { type: 'final' },
      },
    });

    actor = createActor(machine, { inspect: tracing.inspect }).start();
    actor.send({ type: 'FINISH' });

    await tracing.settle();
    expect(spanNames()).toContain('command.too_late');
    expect(getSpan('command.too_late').attributes['actorium.xstate.operation.outcome']).toBe(
      'cancelled',
    );
  });

  it('does not retain telemetry when the same event object is reused', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const tracing = new XStateTracing(tracer);
    let invocation = 0;
    const work = tracing.fromPromise<string, Record<string, never>>('reused.work', () => {
      invocation += 1;
      return invocation === 1 ? first.promise : second.promise;
    });
    const machine = setup({
      types: { events: {} as { type: 'GO' } },
      actors: { work },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { GO: 'first' } },
        first: {
          invoke: {
            src: 'work',
            input: () => ({}),
          },
          on: { GO: 'second' },
        },
        second: {
          invoke: {
            src: 'work',
            input: () => ({}),
            onDone: 'done',
          },
        },
        done: {},
      },
    });
    using actor = createTestActor(machine, { inspect: tracing.inspect }).start();
    const event = { type: 'GO' } as const;

    tracing.sendCommand(actor, event, { name: 'command.first_go' });
    actor.send(event);

    expect(actor.getSnapshot().matches('second')).toBe(true);
    await tracing.settle();
    expect(spansNamed('reused.work')).toHaveLength(1);

    second.resolve('done');
    await waitFor(actor, (snapshot) => snapshot.matches('done'));
    expect(spansNamed('reused.work')).toHaveLength(1);

    first.resolve('late');
  });
});

describe('microsteps', () => {
  it('records raised events as microsteps of the current command', async () => {
    const tracing = new XStateTracing(tracer, { recordMicrosteps: true });
    const machine = setup({
      types: { events: {} as { type: 'OUTER' } | { type: 'RAISED' } },
      actions: { raiseInner: raise({ type: 'RAISED' }) },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            OUTER: { actions: 'raiseInner' },
            RAISED: 'done',
          },
        },
        done: {},
      },
    });
    using actor = createTestActor(machine, { inspect: tracing.inspect }).start();

    tracing.sendCommand(actor, { type: 'OUTER' }, { name: 'command.with_raise' });
    await tracing.settle();
    expect(spanNames()).toContain('command.with_raise');

    const eventTypes = getSpan('command.with_raise').events.map(
      (event) => event.attributes?.['actorium.xstate.event.type'],
    );
    expect(eventTypes).toEqual(expect.arrayContaining(['OUTER', 'RAISED']));
  });

  it('does not serialize microsteps for non-recording operation spans', async () => {
    const tracing = new XStateTracing(trace.getTracer('noop'), { recordMicrosteps: true });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    using actor = createTestActor(
      setup({}).createMachine({
        on: {
          RUN: {
            actions: ({ self, event }) =>
              tracing.inspect({
                type: '@xstate.microstep',
                actorRef: self,
                rootId: self.sessionId,
                event,
                snapshot: { value: circular },
              } as never),
          },
        },
      }),
      { inspect: tracing.inspect },
    ).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'noop.command' });
    await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  });
});

describe('context propagation', () => {
  it('propagates through an invoked machine before its init snapshot', async () => {
    const result = deferred<string>();
    const tracing = new XStateTracing(tracer);
    const nestedWork = tracing.fromPromise<string, Record<string, never>>(
      'nested.work',
      () => result.promise,
    );
    const child = setup({
      actors: { nestedWork },
    }).createMachine({
      initial: 'working',
      states: {
        working: {
          invoke: {
            src: 'nestedWork',
            input: () => ({}),
            onDone: 'done',
          },
        },
        done: { type: 'final' },
      },
    });
    const parent = setup({
      types: { events: {} as { type: 'START' } },
      actors: { child },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { START: 'running' } },
        running: {
          invoke: { src: 'child', onDone: 'done' },
        },
        done: {},
      },
    });
    using actor = createTestActor(parent, { inspect: tracing.inspect }).start();

    tracing.sendCommand(actor, { type: 'START' }, { name: 'nested.start' });
    expect(spanNames()).not.toContain('nested.start');

    result.resolve('done');
    await waitFor(actor, (snapshot) => snapshot.matches('done'));
    await tracing.settle();
    expect(spanNames()).toContain('nested.start');

    const operation = getSpan('nested.start');
    const work = getSpan('nested.work');
    expect(work.spanContext().traceId).toBe(operation.spanContext().traceId);
    expect(work.parentSpanContext?.spanId).toBe(operation.spanContext().spanId);
  });

  it('waits for all parallel finite invokes before ending the semantic operation', async () => {
    const left = deferred<string>();
    const right = deferred<string>();
    const tracing = new XStateTracing(tracer);

    const leftActor = tracing.fromPromise<string, Record<string, never>>(
      'parallel.left',
      () => left.promise,
    );
    const rightActor = tracing.fromPromise<string, Record<string, never>>(
      'parallel.right',
      () => right.promise,
    );

    const machine = setup({
      types: {
        context: {} as { left?: string; right?: string },
        events: {} as { type: 'START' },
      },
      actors: { leftActor, rightActor },
    }).createMachine({
      initial: 'idle',
      context: {},
      states: {
        idle: { on: { START: 'running' } },
        running: {
          type: 'parallel',
          states: {
            left: {
              initial: 'loading',
              states: {
                loading: {
                  invoke: {
                    src: 'leftActor',
                    input: () => ({}),
                    onDone: {
                      target: 'done',
                      actions: assign({ left: ({ event }) => event.output }),
                    },
                  },
                },
                done: { type: 'final' },
              },
            },
            right: {
              initial: 'loading',
              states: {
                loading: {
                  invoke: {
                    src: 'rightActor',
                    input: () => ({}),
                    onDone: {
                      target: 'done',
                      actions: assign({ right: ({ event }) => event.output }),
                    },
                  },
                },
                done: { type: 'final' },
              },
            },
          },
          onDone: 'done',
        },
        done: {},
      },
    });

    using actor = createTestActor(machine, { inspect: tracing.inspect }).start();

    tracing.sendCommand(actor, { type: 'START' }, { name: 'parallel.start' });

    left.resolve('L');
    await tracing.settle();
    expect(spanNames()).toContain('parallel.left');

    // The operation is still open because rightActor is still a continuation.
    expect(spanNames()).not.toContain('parallel.start');

    right.resolve('R');
    await waitFor(actor, (snapshot) => snapshot.matches('done'));
    await tracing.settle();
    expect(spanNames()).toContain('parallel.start');

    const operation = getSpan('parallel.start');
    const leftSpan = getSpan('parallel.left');
    const rightSpan = getSpan('parallel.right');

    expect(leftSpan.parentSpanContext?.spanId).toBe(operation.spanContext().spanId);
    expect(rightSpan.parentSpanContext?.spanId).toBe(operation.spanContext().spanId);
  });

  it('links a fire-and-forget XState trace to the incoming HTTP span', async () => {
    const services: CheckoutServices = {
      loadProduct: async () => ({ id: 'P1', requiresRescan: true }),
      addProduct: async () => ({ id: 'B1', itemCount: 1 }),
    };
    using checkout = createCheckout({
      workflowId: 'checkout-5',
      tracer,
      services,
    });
    const { actor, tracing } = checkout;

    const httpSpan = tracer.startSpan('POST /add-item', undefined, ROOT_CONTEXT);
    const httpContext = trace.setSpan(ROOT_CONTEXT, httpSpan);

    context.with(httpContext, () => {
      tracing.sendCommand(
        actor,
        { type: 'ADD_ITEM', barcode: '123' },
        {
          name: 'checkout.add_item',
          relationship: 'link',
        },
      );
    });
    httpSpan.end();

    await waitFor(actor, (snapshot) => snapshot.matches('waitingForRescan'));
    await tracing.settle();
    expect(spansNamed('checkout.add_item')).toHaveLength(1);

    const operation = getSpan('checkout.add_item');
    const http = getSpan('POST /add-item');

    expect(operation.spanContext().traceId).not.toBe(http.spanContext().traceId);
    expect(operation.links[0]?.context.traceId).toBe(http.spanContext().traceId);
    expect(operation.links[0]?.context.spanId).toBe(http.spanContext().spanId);
  });
});
