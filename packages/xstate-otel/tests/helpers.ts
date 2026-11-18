import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {
  createActor,
  type Actor,
  type ActorOptions,
  type AnyActorLogic,
  type AnyActorRef,
  type AnyEventObject,
  type ConditionalRequired,
  type IsNotNever,
  type RequiredActorOptionsKeys,
} from 'xstate';
import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';
import type { CommandResult } from '../src/index.js';

/**
 * A tracer that records to memory for the test file that calls this at module
 * level: the exporter resets before each test and the provider shuts down
 * after the file. `contextManager` installs an AsyncLocalStorage context
 * manager for tests that need active-span propagation across awaits.
 */
export function useTestTracer(name: string, options: { contextManager?: boolean } = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  if (options.contextManager) {
    const manager = new AsyncLocalStorageContextManager();
    beforeAll(() => {
      context.setGlobalContextManager(manager.enable());
    });
    afterAll(() => {
      context.disable();
    });
  }
  beforeEach(() => exporter.reset());
  afterAll(() => provider.shutdown());
  const spans = () => exporter.getFinishedSpans();
  const spansNamed = (spanName: string) => spans().filter((span) => span.name === spanName);
  return {
    tracer: provider.getTracer(name),
    exporter,
    /** Every span finished in the current test. */
    spans,
    spansNamed,
    spanNames: () => spans().map((span) => span.name),
    /** The one finished span with this name; fails clearly when there are none or several. */
    getSpan(spanName: string): ReadableSpan {
      const matching = spansNamed(spanName);
      expect(matching, `expected exactly one "${spanName}" span`).toHaveLength(1);
      return matching[0]!;
    },
  };
}

/**
 * Creates a root actor, not yet started, that stops when its `using` scope
 * ends, so a failing assertion cannot leave it, or its timers, running into
 * later tests. Call `.start()` on it (XState's `start()` returns the actor, so
 * the result stays disposable). Stopping twice is harmless, so tests may
 * still stop an actor on purpose.
 */
export function createTestActor<TLogic extends AnyActorLogic>(
  logic: TLogic,
  // The same parameters as createActor, so required input stays required.
  ...options: ConditionalRequired<
    [options?: ActorOptions<TLogic> & { [K in RequiredActorOptionsKeys<TLogic>]: unknown }],
    IsNotNever<RequiredActorOptionsKeys<TLogic>>
  >
): Actor<TLogic> & Disposable {
  const actor = createActor(logic, ...options);
  return Object.assign(actor, { [Symbol.dispose]: () => actor.stop() });
}

/** Assert warnings only around deliberate stopped-actor deliveries. */
export function expectStoppedActorWarnings<T>(
  actor: AnyActorRef,
  eventTypes: readonly string[],
  deliver: () => T,
): T {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = deliver();
    expect(warning).toHaveBeenCalledTimes(eventTypes.length);
    for (const [index, type] of eventTypes.entries()) {
      const call = warning.mock.calls[index]!;
      expect(call.length).toBe(1);
      // Compare the diagnostic header without printing serialized payloads.
      const header =
        `Event "${type}" was sent to stopped actor "${actor.id} (${actor.sessionId})". ` +
        'This actor has already reached its final state, and will not transition.';
      expect(typeof call[0]).toBe('string');
      expect(call[0].startsWith(`${header}\nEvent: `), header).toBe(true);
    }
    return result;
  } finally {
    warning.mockRestore();
  }
}

// Waiting in tests: prefer `await command.finished`, `await tracing.settle()`
// or XState's `waitFor(actor, predicate)`, then assert. Poll with
// `vi.waitFor(() => expect(...))` only for work tracing cannot await (a
// Promise settling outside an operation, a real timer), and say why there.

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/** A recorded delivery, as the runtime keeps it in `processing` and `queued`. */
export interface DeliveryRecord {
  event: AnyEventObject;
  operation:
    | { id: number; pendingDeliveries: number; ended: boolean; finished: Promise<CommandResult> }
    | undefined;
}

/**
 * The private state tests inspect, named as in OperationRuntime
 * (core/runtime.ts) and ScheduledWork (core/scheduled-work.ts). Keyed tables
 * use `object` keys so tests can pass any actor reference.
 */
export interface RuntimeInternals {
  processing: WeakMap<object, DeliveryRecord>;
  queued: WeakMap<object, Iterable<DeliveryRecord> & { readonly length: number }>;
  pendingCommands: WeakMap<object, unknown>;
  actorOperations: WeakMap<object, unknown>;
  actorContinuations: WeakMap<object, unknown>;
  observedActors: WeakSet<object>;
  rootActors: WeakSet<object>;
  lifecycleChecks: WeakSet<object>;
  bookkeeping: Set<{ pending: number; waiters: Array<() => void> }>;
  activeBookkeeping: unknown;
  scheduleBookkeeping(callback: () => void): void;
  instrumentedSystems: WeakSet<object>;
  scheduledRegistrations: WeakMap<object, WeakMap<object, unknown>>;
  scheduledByActor: WeakMap<object, Set<object>>;
}

/** Tables that hold per-actor work; all must be empty once that work is over. */
const perActorTables = [
  'processing',
  'queued',
  'pendingCommands',
  'actorOperations',
  'actorContinuations',
  'scheduledByActor',
  'scheduledRegistrations',
] as const;

/** Asserts that the runtime retains no work for these actors. */
export function expectReleased(tracing: object, ...actors: AnyActorRef[]): void {
  const runtime = internals(tracing);
  for (const actor of actors)
    for (const table of perActorTables) expect(runtime[table].has(actor), table).toBe(false);
}

/**
 * White-box view of the lifecycle runtime behind an XStateTracing instance:
 * its private tables and methods, plus the scheduled-work tables, by name.
 */
export function internals(tracing: object): RuntimeInternals {
  const runtime = (tracing as { runtime: object & { scheduledWork: object } }).runtime;
  const view = new Proxy(runtime, {
    get(target, key) {
      const source = key in target ? target : target.scheduledWork;
      const value: unknown = Reflect.get(source, key);
      return typeof value === 'function' ? value.bind(source) : value;
    },
  });
  return view as unknown as RuntimeInternals;
}
