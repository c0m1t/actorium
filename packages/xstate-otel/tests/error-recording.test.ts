import { SpanStatusCode, type Span, type Tracer, diag } from '@opentelemetry/api';
import { createActor, setup, fromCallback, sendTo } from 'xstate';
import { beforeEach, expect, it, vi } from 'vitest';
import { createXStateTracing, XStateTracing } from '../src/index.js';
import { deferred, createTestActor, useTestTracer } from './helpers.js';

const {
  tracer: baseTracer,
  exporter,
  spans,
  spansNamed,
  getSpan,
} = useTestTracer('error-recording');
let postEndWrites: string[] = [];
const tracer: Tracer = {
  ...baseTracer,
  startActiveSpan: baseTracer.startActiveSpan.bind(baseTracer),
  startSpan(...args: Parameters<Tracer['startSpan']>) {
    const span = baseTracer.startSpan(...args);
    let ended = false;
    for (const method of ['setStatus', 'setAttribute', 'recordException', 'addEvent'] as const) {
      const original = span[method].bind(span) as (...values: unknown[]) => Span;
      vi.spyOn(span, method).mockImplementation((...values: unknown[]) => {
        if (ended) postEndWrites.push(method);
        return original(...values);
      });
    }
    const end = span.end.bind(span);
    vi.spyOn(span, 'end').mockImplementation((...values) => {
      if (ended) postEndWrites.push('end');
      ended = true;
      end(...values);
    });
    return span;
  },
};
beforeEach(() => {
  postEndWrites = [];
});

const unsafeRead = vi.fn(() => {
  throw new Error('must not read business getters');
});
const plainError = new TypeError('declined');
const dataStackError = new Error('declined');
Object.defineProperty(dataStackError, 'stack', {
  value: 'Error: declined\n at businessWork',
  configurable: true,
});
const cases = [
  {
    label: 'Error',
    error: plainError,
    type: 'TypeError',
    message: 'declined',
  },
  { label: 'Error with data stack', error: dataStackError, type: 'Error', message: 'declined' },
  { label: 'string', error: 'declined', type: 'string', message: 'declined' },
  { label: 'number', error: 42, type: 'number', message: '42' },
  { label: 'boolean', error: false, type: 'boolean', message: 'false' },
  { label: 'null', error: null, type: 'null', message: 'null' },
  { label: 'undefined', error: undefined, type: 'undefined', message: 'undefined' },
  { label: 'bigint', error: 42n, type: 'bigint', message: '42' },
  { label: 'symbol', error: Symbol('declined'), type: 'symbol', message: 'Symbol(declined)' },
  {
    label: 'data object',
    error: Object.freeze({
      name: 'ServiceError',
      message: 'declined',
      stack: 'business stack',
      secret: 'omit',
    }),
    type: 'ServiceError',
    message: 'declined',
  },
  {
    label: 'opaque object',
    error: { secret: 'omit', toString: unsafeRead, toJSON: unsafeRead },
    type: 'object',
    unavailable: true,
  },
  {
    label: 'inherited accessors',
    error: Object.create({
      get name() {
        return 'BusinessError';
      },
      get message() {
        return 'declined';
      },
      get stack() {
        return 'BusinessError: declined';
      },
    }),
    type: 'BusinessError',
    message: 'declined',
  },
];

it.each(cases)(
  'records recovered $label rejection without changing its value',
  async ({ error, type, message, unavailable }) => {
    const observed = vi.fn();
    const tracing = createXStateTracing({ tracer });
    const work = tracing.fromPromise('work', async () => {
      throw error;
    });
    const machine = setup({ actors: { work } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: {
          invoke: {
            src: 'work',
            onError: { target: 'recovered', actions: ({ event }) => observed(event.error) },
          },
        },
        recovered: {},
      },
    });
    using actor = createTestActor(machine, { inspect: tracing.inspect }).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'command' });
    await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: true });
    await tracing.waitForBookkeeping();
    expect(observed.mock.calls.length).toBe(1);
    expect(Object.is(observed.mock.calls[0]![0], error)).toBe(true);
    const child = getSpan('work');
    const parent = getSpan('command');
    expect(child.status).toEqual({
      code: SpanStatusCode.ERROR,
      ...(message === undefined ? {} : { message }),
    });
    expect(child.events).toHaveLength(1);
    expect(child.events[0]?.name).toBe('exception');
    expect(child.events[0]?.attributes?.['exception.type']).toBe(type);
    expect(child.events[0]?.attributes?.['exception.message']).toBe(message);
    expect(child.attributes['actorium.xstate.error.details_unavailable']).toBe(unavailable);
    if (error === plainError)
      expect(child.events[0]?.attributes?.['exception.stacktrace']).toContain(
        'TypeError: declined',
      );
    if (error === dataStackError)
      expect(child.events[0]?.attributes?.['exception.stacktrace']).toBe(
        'Error: declined\n at businessWork',
      );
    expect(parent.status.code).toBe(SpanStatusCode.UNSET);
    expect(parent.events).toHaveLength(0);
    expect(parent.attributes['actorium.xstate.operation.had_error']).toBe(true);
    expect(parent.attributes['actorium.xstate.operation.error_count']).toBe(1);
    expect(unsafeRead).not.toHaveBeenCalled();
    expect(postEndWrites).toEqual([]);
  },
);

it.each(['action', 'send', 'unhandled child'] as const)(
  'records one operation exception for %s failure',
  async (source) => {
    const error = 'original failure';
    const tracing = createXStateTracing({ tracer, onDiagnostic: () => {} });
    const work = tracing.fromPromise('work', async () => {
      throw error;
    });
    const machine = setup({ actors: { work } }).createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            RUN:
              source === 'unhandled child'
                ? 'working'
                : {
                    actions: () => {
                      throw error;
                    },
                  },
          },
        },
        working: { invoke: { src: 'work' } },
      },
    });
    using actor = createTestActor(machine, { inspect: tracing.inspect });
    const observed = vi.fn();
    actor.subscribe({ error: observed });
    actor.start();
    if (source === 'send') {
      vi.spyOn(actor, 'send').mockImplementationOnce(() => {
        throw error;
      });
      let caught: unknown;
      try {
        tracing.sendCommand(actor, { type: 'RUN' }, { name: 'command' });
      } catch (value) {
        caught = value;
      }
      expect(caught).toBe(error);
    } else {
      await expect(
        tracing.sendCommand(actor, { type: 'RUN' }, { name: 'command' }).finished,
      ).resolves.toEqual({ outcome: 'failed', hadError: true });
      expect(observed).toHaveBeenCalledExactlyOnceWith(error);
    }
    await tracing.waitForBookkeeping();
    const span = getSpan('command');
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: error });
    expect(span.events).toHaveLength(1);
    expect(span.events[0]?.attributes?.['exception.message']).toBe(error);
    expect(postEndWrites).toEqual([]);
  },
);

it.each(['cancel', 'independent abort', 'late rejection'] as const)(
  'preserves %s classification and ended spans',
  async (mode) => {
    const pending = deferred<never>();
    const tracing = createXStateTracing({ tracer });
    const work = tracing.fromPromise('work', ({ signal }) => {
      if (mode === 'cancel')
        signal.addEventListener('abort', () =>
          pending.reject(new DOMException('Aborted', 'AbortError')),
        );
      return pending.promise;
    });
    const machine = setup({ actors: { work } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: { invoke: { src: 'work', onError: 'done' }, on: { STOP: 'done' } },
        done: {},
      },
    });
    using actor = createTestActor(machine, { inspect: tracing.inspect }).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'command' });
    if (mode === 'independent abort') pending.reject(new DOMException('independent', 'AbortError'));
    else actor.send({ type: 'STOP' });
    await expect(command.finished).resolves.toEqual({
      outcome: mode === 'independent abort' ? 'completed' : 'cancelled',
      hadError: mode === 'independent abort',
    });
    if (mode === 'late rejection') pending.reject('too late');
    // Let the underlying Promise rejection and XState reaction run after stop.
    await pending.promise.catch(() => {});
    await tracing.waitForBookkeeping();
    const child = getSpan('work');
    expect(child.status.code).toBe(
      mode === 'independent abort' ? SpanStatusCode.ERROR : SpanStatusCode.UNSET,
    );
    expect(child.events).toHaveLength(mode === 'independent abort' ? 1 : 0);
    expect(child.attributes['actorium.xstate.work.outcome']).toBe(
      mode === 'independent abort' ? undefined : 'cancelled',
    );
    expect(postEndWrites).toEqual([]);
  },
);

async function runMappedFailure(
  errorDetails: import('../src/index.js').XStateTracingOptions['errorDetails'],
  error: unknown = new Error('SECRET'),
  onDiagnostic = vi.fn((_diagnostic: import('../src/index.js').TelemetryDiagnostic) => {}),
) {
  const tracing = createXStateTracing({
    tracer,
    ...(errorDetails === undefined ? {} : { errorDetails }),
    onDiagnostic,
  });
  const received = vi.fn();
  const work = tracing.fromPromise('mapped.work', async () => {
    throw error;
  });
  const machine = setup({ actors: { work } }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { RUN: 'working' } },
      working: {
        invoke: {
          src: 'work',
          onError: { target: 'done', actions: ({ event }) => received(event.error) },
        },
      },
      done: {},
    },
  });
  using actor = createTestActor(machine, { inspect: tracing.inspect }).start();
  await expect(
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'mapped.command' }).finished,
  ).resolves.toEqual({ outcome: 'completed', hadError: true });
  await tracing.waitForBookkeeping();
  expect(received.mock.calls).toHaveLength(1);
  expect(Object.is(received.mock.calls[0]![0], error)).toBe(true);
  expect(postEndWrites).toEqual([]);
  return getSpan('mapped.work');
}

it('replaces default details with application redaction and event attributes', async () => {
  const error = { code: 'DECLINED', secret: 'SECRET', cause: {} };
  error.cause = error;
  const codes = ['DECLINED'];
  const attributes = { 'payment.codes': codes, 'payment.retryable': false, 'payment.attempt': 1 };
  const mapper = vi.fn((original: unknown): import('../src/index.js').ErrorDetails => {
    expect(original).toBe(error);
    return { type: 'PaymentError', message: 'Payment failed', stack: 'redacted stack', attributes };
  });
  const span = await runMappedFailure(mapper, error);
  expect(mapper).toHaveBeenCalledTimes(1);
  expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'Payment failed' });
  expect(span.events).toHaveLength(1);
  expect(span.events[0]?.attributes).toEqual({
    'exception.type': 'PaymentError',
    'exception.message': 'Payment failed',
    'exception.stacktrace': 'redacted stack',
    'payment.codes': ['DECLINED'],
    'payment.retryable': false,
    'payment.attempt': 1,
  });
  expect(span.attributes['actorium.xstate.error.details_unavailable']).toBeUndefined();
});

it.each([
  { label: 'empty', details: {}, events: 0 },
  { label: 'message only', details: { message: 'safe' }, events: 1 },
  { label: 'attributes only', details: { attributes: { 'business.code': 'DECLINED' } }, events: 1 },
])('allows $label replacement without restoring default fields', async ({ details, events }) => {
  const span = await runMappedFailure(() => details);
  expect(span.events).toHaveLength(events);
  expect(span.events[0]?.attributes?.['exception.type']).toBeUndefined();
  expect(span.events[0]?.attributes?.['exception.stacktrace']).toBeUndefined();
  expect(span.status).toEqual({
    code: SpanStatusCode.ERROR,
    ...('message' in details ? { message: details.message } : {}),
  });
  expect(span.attributes['actorium.xstate.error.details_unavailable']).toBeUndefined();
});

const mappingFailures: Array<[string, () => import('../src/index.js').ErrorDetails]> = [
  [
    'throw',
    () => {
      throw new Error('mapper failed');
    },
  ],
  [
    'field getter',
    () => ({
      get message(): string {
        throw new Error('field getter failed');
      },
    }),
  ],
  [
    'attribute getter',
    () => ({
      attributes: {
        get code(): string {
          throw new Error('attribute getter failed');
        },
      },
    }),
  ],
];
it.each(mappingFailures)(
  'protects %s without falling back to raw error details',
  async (_label, callback) => {
    const diagnostic = vi.fn((_value: import('../src/index.js').TelemetryDiagnostic) => {
      throw new Error('reporter failed');
    });
    const mapper = vi.fn(callback);
    const span = await runMappedFailure(mapper, undefined, diagnostic);
    expect(mapper).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic.mock.calls[0]?.[0].phase).toBe('errorDetails');
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(span.events).toHaveLength(0);
    expect(span.attributes['actorium.xstate.error.details_unavailable']).toBe(true);
  },
);

it('accepts typed getters and exception attributes with dedicated field precedence', async () => {
  const span = await runMappedFailure(() => ({
    get type() {
      return 'BusinessError';
    },
    message: 'safe',
    stack: 'safe stack',
    attributes: {
      'exception.type': 'overridden',
      'exception.message': 'overridden',
      'exception.stacktrace': 'overridden',
      'exception.escaped': true,
      'business.codes': ['A', 'B'],
    },
  }));
  expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'safe' });
  expect(span.events[0]?.attributes).toEqual({
    'exception.type': 'BusinessError',
    'exception.message': 'safe',
    'exception.stacktrace': 'safe stack',
    'exception.escaped': true,
    'business.codes': ['A', 'B'],
  });
});

it.each([
  { label: 'default', options: {}, key: 'actorium.xstate.error.details_unavailable' },
  {
    label: 'custom',
    options: { detailsUnavailableAttribute: 'app.details_unavailable' },
    key: 'app.details_unavailable',
  },
  { label: 'disabled', options: { detailsUnavailableAttribute: false as const }, key: undefined },
])('supports the $label unavailable-details marker', async ({ options, key }) => {
  const tracing = createXStateTracing({
    tracer,
    ...options,
    errorDetails: () => {
      throw new Error('mapping failed');
    },
    onDiagnostic: () => {},
  });
  const work = tracing.fromPromise('marker.work', async () => {
    throw new Error('SECRET');
  });
  const machine = setup({ actors: { work } }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { RUN: 'working' } },
      working: { invoke: { src: 'work', onError: 'done' } },
      done: {},
    },
  });
  using actor = createTestActor(machine, { inspect: tracing.inspect }).start();
  await expect(
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'marker.command' }).finished,
  ).resolves.toEqual({ outcome: 'completed', hadError: true });
  const span = getSpan('marker.work');
  expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
  expect(span.events).toHaveLength(0);
  expect(span.attributes['actorium.xstate.error.details_unavailable']).toBe(
    key === 'actorium.xstate.error.details_unavailable' ? true : undefined,
  );
  if (key) expect(span.attributes[key]).toBe(true);
  expect(postEndWrites).toEqual([]);
});

it('calls the mapper once on each failed span for an unhandled child', async () => {
  const mapper = vi.fn((_error: unknown) => ({ message: 'safe' }));
  const tracing = createXStateTracing({ tracer, errorDetails: mapper, onDiagnostic: () => {} });
  const error = new Error('SECRET');
  const work = tracing.fromPromise('work', async () => {
    throw error;
  });
  const machine = setup({ actors: { work } }).createMachine({
    initial: 'idle',
    states: { idle: { on: { RUN: 'working' } }, working: { invoke: { src: 'work' } } },
  });
  using actor = createTestActor(machine, { inspect: tracing.inspect });
  actor.subscribe({ error: () => {} });
  actor.start();
  await expect(
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'command' }).finished,
  ).resolves.toEqual({ outcome: 'failed', hadError: true });
  await tracing.waitForBookkeeping();
  expect(mapper).toHaveBeenCalledTimes(2);
  expect(mapper.mock.calls.every((args) => Object.is(args[0], error))).toBe(true);
  for (const span of exporter.getFinishedSpans()) {
    expect(span.events).toHaveLength(1);
    expect(span.events[0]?.attributes).toEqual({ 'exception.message': 'safe' });
  }
  expect(postEndWrites).toEqual([]);
});

it('does not call the mapper for cancellation or late rejection', async () => {
  const mapper = vi.fn(() => ({ message: 'should not run' }));
  const tracing = createXStateTracing({ tracer, errorDetails: mapper });
  const pending = deferred<never>();
  const work = tracing.fromPromise('work', () => pending.promise);
  const machine = setup({ actors: { work } }).createMachine({
    initial: 'idle',
    states: { idle: { on: { RUN: 'working' } }, working: { invoke: { src: 'work' } } },
  });
  using actor = createTestActor(machine, { inspect: tracing.inspect }).start();
  const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'command' });
  actor.stop();
  await expect(command.finished).resolves.toEqual({ outcome: 'cancelled', hadError: false });
  pending.reject(new Error('SECRET'));
  await pending.promise.catch(() => {});
  await tracing.waitForBookkeeping();
  expect(mapper).not.toHaveBeenCalled();
  expect(postEndWrites).toEqual([]);
});

it.each(['mapper', 'diagnostic'] as const)(
  'rechecks span lifetime after reentrant %s actor stop',
  async (source) => {
    let actor: ReturnType<typeof createActor>;
    const stop = () => actor.stop();
    const tracing = createXStateTracing({
      tracer,
      errorDetails: () => {
        if (source === 'diagnostic') throw new Error('mapper failed');
        stop();
        return { message: 'safe' };
      },
      onDiagnostic: stop,
    });
    const work = tracing.fromPromise('work', async () => {
      throw new Error('SECRET');
    });
    const machine = setup({ actors: { work } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: { invoke: { src: 'work', onError: 'done' } },
        done: {},
      },
    });
    actor = createActor(machine, { inspect: tracing.inspect }).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'command' });
    await command.finished;
    await tracing.waitForBookkeeping();
    expect(postEndWrites).toEqual([]);
    const marked = spans().filter((span) => span.status.code === SpanStatusCode.ERROR).length;
    const operation = getSpan('command');
    expect(operation.attributes['actorium.xstate.operation.error_count']).toBe(marked || undefined);
  },
);

it('contains default property-access failures without changing the business error', async () => {
  const failure = new Error('getter failed');
  const read = vi.fn(() => {
    throw failure;
  });
  const error = Object.defineProperty({}, 'message', { get: read });
  const diagnostic = vi.fn((_value: import('../src/index.js').TelemetryDiagnostic) => {});
  const span = await runMappedFailure(undefined, error, diagnostic);
  expect(read).toHaveBeenCalledTimes(1);
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ phase: 'errorDetails', error: failure });
  expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
  expect(span.events).toHaveLength(0);
  expect(span.attributes['actorium.xstate.error.details_unavailable']).toBe(true);
});

it('counts each failed work span once and omits the count without failures', async () => {
  const tracing = createXStateTracing({ tracer });
  const failing = tracing.fromPromise('work', async () => {
    throw new Error('declined');
  });
  const machine = setup({ actors: { failing } }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { RUN: 'working' } },
      working: {
        type: 'parallel',
        states: {
          a: {
            invoke: { src: 'failing', id: 'a', onError: '.done' },
            initial: 'run',
            states: { run: {}, done: {} },
          },
          b: {
            invoke: { src: 'failing', id: 'b', onError: '.done' },
            initial: 'run',
            states: { run: {}, done: {} },
          },
        },
      },
    },
  });
  using actor = createTestActor(machine, { inspect: tracing.inspect }).start();
  await expect(
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'fanout' }).finished,
  ).resolves.toEqual({ outcome: 'completed', hadError: true });
  const operation = spansNamed('fanout')[0];
  expect(operation?.attributes['actorium.xstate.operation.error_count']).toBe(2);

  exporter.reset();
  using clean = createTestActor(setup({}).createMachine({ on: { PING: {} } }), {
    inspect: tracing.inspect,
  }).start();
  await tracing.sendCommand(clean, { type: 'PING' }, { name: 'clean' }).finished;
  const span = spansNamed('clean')[0];
  expect(span?.attributes).not.toHaveProperty('actorium.xstate.operation.error_count');
  expect(postEndWrites).toEqual([]);
});

it.each(['action', 'startup'] as const)(
  'settles handled child %s failures without a snapshot',
  async (mode) => {
    const tracing = new XStateTracing(tracer);
    const child =
      mode === 'startup'
        ? fromCallback(() => {
            throw new Error('startup');
          })
        : setup({}).createMachine({
            on: {
              FAIL: {
                actions: () => {
                  throw new Error('action');
                },
              },
            },
          });
    const parent = setup({ actors: { child } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: {
          invoke: { id: 'child', src: 'child', onError: 'handled' },
          ...(mode === 'action' ? { entry: sendTo('child', { type: 'FAIL' }) } : {}),
        },
        handled: {},
      },
    });
    using actor = createTestActor(parent, { inspect: tracing.inspect }).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: `child.${mode}` });
    await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: true });
    expect(actor.getSnapshot().value).toBe('handled');
  },
);

it.each(['operationAttributes', 'workAttributes'] as const)(
  'isolates %s failures without skipping business work',
  async (phase) => {
    const diagnostics = vi.fn();
    const tracing = new XStateTracing(tracer, {
      [phase]: () => {
        throw new Error('telemetry failed');
      },
      commonAttributes: { retained: 'yes' },
      onDiagnostic: diagnostics,
    });
    let executions = 0;
    const work = tracing.fromPromise<string, object>('safe.work', async () => {
      executions++;
      return 'done';
    });
    using actor = createTestActor(
      setup({ actors: { work } }).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { RUN: 'working' } },
          working: {
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
    await expect(
      tracing.sendCommand(actor, { type: 'RUN' }, { name: 'safe.command' }).finished,
    ).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(executions).toBe(1);
    expect(diagnostics).toHaveBeenCalledWith({ phase, error: expect.any(Error) });
    expect(getSpan('safe.work').attributes.retained).toBe('yes');
  },
);

it('marks a spontaneous AbortError as failure instead of cancellation', async () => {
  const tracing = new XStateTracing(tracer);
  const work = tracing.fromPromise<string, object>('abort.work', async () => {
    throw new DOMException('timeout', 'AbortError');
  });
  using actor = createTestActor(
    setup({ actors: { work } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: {
          invoke: {
            src: 'work',
            input: () => ({}),
            onError: 'handled',
          },
        },
        handled: {},
      },
    }),
    { inspect: tracing.inspect },
  ).start();
  await expect(
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'abort.command' }).finished,
  ).resolves.toEqual({ outcome: 'completed', hadError: true });
  const span = getSpan('abort.work');
  expect(span.status.code).toBe(SpanStatusCode.ERROR);
  expect(span.attributes['actorium.xstate.work.outcome']).toBeUndefined();
});

it('does not swallow callbacks passed to withActiveOperation', async () => {
  const diagnostic = vi.fn();
  const tracing = new XStateTracing(tracer, { onDiagnostic: diagnostic });
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: {
          actions: ({ self }) =>
            tracing.withActiveOperation(self, () => {
              throw new Error('business failure');
            }),
        },
      },
    }),
    { inspect: tracing.inspect },
  );
  const onError = vi.fn();
  actor.subscribe({ error: onError });
  actor.start();
  await expect(
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'business.failure' }).finished,
  ).resolves.toEqual({ outcome: 'failed', hadError: true });
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'associatedRootError',
    error: actor.getSnapshot().error,
  });
  expect(onError).toHaveBeenCalledExactlyOnceWith(actor.getSnapshot().error);
});

it('reports callback errors through protected OpenTelemetry diagnostics by default', async () => {
  const warning = vi.spyOn(diag, 'warn').mockImplementation(() => {
    throw new Error('logger failed');
  });
  try {
    const tracing = new XStateTracing(tracer, {
      operationAttributes: () => {
        throw new Error('attributes failed');
      },
    });
    using actor = createTestActor(setup({}).createMachine({}), {
      inspect: tracing.inspect,
    }).start();
    await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'default.diagnostics' }).finished;
    expect(warning).toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});
