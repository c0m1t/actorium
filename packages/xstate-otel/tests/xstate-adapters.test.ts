import { SpanStatusCode } from '@opentelemetry/api';
import { assign, createActor, setup, type ActorRefLike, type AnyActorRef } from 'xstate';
import { describe, expect, it, vi } from 'vitest';
import {
  XStateTracing,
  type TelemetryDiagnostic,
  type XStateTracingOptions,
} from '../src/index.js';
import {
  createTestActor,
  expectStoppedActorWarnings,
  internals,
  useTestTracer,
} from './helpers.js';

// Focused coverage for the two places that rely on XState behaviour outside its
// documented API: the private `_parent` lookup and the public `stop` wrapper.

const { tracer, spansNamed, getSpan } = useTestTracer('xstate-adapters');
const nativeParent = (actor: ActorRefLike) =>
  (actor as ActorRefLike & { _parent?: ActorRefLike })._parent;

const empty = setup({}).createMachine({});
const actorPrototype = Object.getPrototypeOf(createActor(empty)) as {
  stop(...args: unknown[]): unknown;
};

function worker(tracing: XStateTracing) {
  const work = tracing.fromPromise<string, object>('adapter.work', async () => 'done');
  return setup({ actors: { work } }).createMachine({ invoke: { src: 'work', input: () => ({}) } });
}

describe('public stop delegation', () => {
  it('wraps only root actors and keeps the native child rejection', () => {
    const tracing = new XStateTracing(tracer);
    using actor = createTestActor(
      setup({ actors: { child: empty } }).createMachine({ invoke: { src: 'child', id: 'child' } }),
      { inspect: tracing.inspect },
    ).start();
    const child = actor.getSnapshot().children.child!;
    expect(Object.hasOwn(actor, 'stop')).toBe(true);
    expect(Object.hasOwn(child, 'stop')).toBe(false);
    expect(() => child.stop()).toThrow('A non-root actor cannot be stopped directly.');
  });

  it('delegates receiver, arguments and return value, then cancels the pre-start mailbox', async () => {
    const stop = vi.spyOn(actorPrototype, 'stop');
    try {
      const tracing = new XStateTracing(tracer);
      // This test drives stop() itself, so it is not disposed.
      const actor = createActor(empty, { inspect: tracing.inspect });
      const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'stop.delegation' });
      const result = (actor.stop as (...args: unknown[]) => unknown)('reason', 1);
      expect(stop).toHaveBeenCalledOnce();
      expect(stop.mock.calls[0]).toEqual(['reason', 1]);
      expect(stop.mock.contexts[0]).toBe(actor);
      expect(result).toBe(actor);
      await expect(command.finished).resolves.toEqual({ outcome: 'cancelled', hadError: false });
    } finally {
      stop.mockRestore();
    }
  });

  it('propagates stop failures unchanged and reconciles only after a successful stop', async () => {
    const failure = new Error('stop failed');
    const stop = vi.spyOn(actorPrototype, 'stop').mockImplementationOnce(() => {
      throw failure;
    });
    try {
      const tracing = new XStateTracing(tracer);
      // The spied stop() throws, so this test stops the actor itself.
      const actor = createActor(empty, { inspect: tracing.inspect });
      const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'stop.failure' });
      let finished = false;
      void command.finished.then(() => {
        finished = true;
      });
      let thrown: unknown;
      try {
        actor.stop();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(failure);
      await tracing.settle();
      expect(finished).toBe(false);
      actor.stop();
      await expect(command.finished).resolves.toEqual({ outcome: 'cancelled', hadError: false });
    } finally {
      stop.mockRestore();
    }
  });

  it('keeps native behaviour for repeated and detached stop calls', async () => {
    const tracing = new XStateTracing(tracer);
    using actor = createTestActor(empty, { inspect: tracing.inspect });
    // Like the native method, a detached call has no receiver to stop.
    expect(() => Reflect.apply(actor.stop, undefined, [])).toThrow(TypeError);
    expect(() => Reflect.apply(createActor(empty).stop, undefined, [])).toThrow(TypeError);
    const pending = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'stop.repeated' });
    expect(actor.stop()).toBe(actor);
    expect(actor.stop()).toBe(actor);
    await expect(pending.finished).resolves.toEqual({ outcome: 'cancelled', hadError: false });
    await expect(
      expectStoppedActorWarnings(actor, ['RUN'], () =>
        tracing.sendCommand(actor, { type: 'RUN' }, { name: 'stop.after' }),
      ).finished,
    ).resolves.toEqual({ outcome: 'target_terminal', hadError: false });
  });
});

describe('parent lookup', () => {
  it('joins children spawned during a command to that command', async () => {
    const tracing = new XStateTracing(tracer);
    const child = worker(tracing);
    using actor = createTestActor(
      setup({ actors: { child } }).createMachine({
        context: { child: undefined as AnyActorRef | undefined },
        on: { RUN: { actions: assign({ child: ({ spawn }) => spawn('child') }) } },
      }),
      { inspect: tracing.inspect },
    ).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'spawn.command' });
    await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(getSpan('adapter.work').parentSpanContext?.spanId).toBe(command.spanId);
  });

  it.each(['native', 'missing'] as const)(
    'classifies roots and ownership from the %s parent',
    async (mode) => {
      const tracing = new XStateTracing(
        tracer,
        mode === 'missing' ? { resolveParentActor: () => undefined } : {},
      );
      const child = worker(tracing);
      using actor = createTestActor(
        setup({ actors: { child } }).createMachine({
          initial: 'idle',
          states: {
            idle: { on: { RUN: 'working' } },
            working: { invoke: { src: 'child', id: 'child' } },
          },
        }),
        { inspect: tracing.inspect },
      ).start();
      const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'parent.command' });
      await command.finished;
      const invoked = actor.getSnapshot().children.child!;
      expect(internals(tracing).rootActors.has(actor)).toBe(true);
      expect(internals(tracing).rootActors.has(invoked)).toBe(mode === 'missing');
      // Stop wrapping follows XState's own parent, not the configured resolver.
      expect(Object.hasOwn(invoked, 'stop')).toBe(false);
      const work = spansNamed('adapter.work')[0];
      if (mode === 'native') expect(work?.parentSpanContext?.spanId).toBe(command.spanId);
      else expect(work).toBeUndefined();
    },
  );

  it.each(['native', 'custom'] as const)(
    'associates a separately created root through the %s parent',
    async (mode) => {
      let root: AnyActorRef | undefined;
      let detached: AnyActorRef | undefined;
      const options: XStateTracingOptions =
        mode === 'custom'
          ? {
              resolveParentActor: (actor) =>
                'id' in actor && actor.id === 'detached' ? root : nativeParent(actor),
            }
          : {};
      const tracing = new XStateTracing(tracer, options);
      const machine = worker(tracing);
      root = createActor(
        setup({}).createMachine({
          on: {
            RUN: {
              actions: () => {
                detached = createActor(machine, { id: 'detached', inspect: tracing.inspect });
                detached.start();
              },
            },
          },
        }),
        { inspect: tracing.inspect },
      ).start();
      const command = tracing.sendCommand(root, { type: 'RUN' }, { name: 'custom.command' });
      await command.finished;
      expect(internals(tracing).rootActors.has(detached!)).toBe(mode === 'native');
      const work = spansNamed('adapter.work')[0];
      if (mode === 'custom') expect(work?.parentSpanContext?.spanId).toBe(command.spanId);
      else expect(work).toBeUndefined();
      detached!.stop();
      root.stop();
    },
  );

  it.each(['native', 'throwing'] as const)(
    'delivers the original child error to its parent with a %s resolver',
    async (mode) => {
      const failure = new Error('work failed');
      const diagnostics = vi.fn((_diagnostic: TelemetryDiagnostic) => {});
      const tracing = new XStateTracing(tracer, {
        onTelemetryError: diagnostics,
        ...(mode === 'throwing'
          ? {
              resolveParentActor: () => {
                throw new Error('resolver failed');
              },
            }
          : {}),
      });
      const work = tracing.fromPromise<string, object>('failing.work', async () => {
        throw failure;
      });
      let received: unknown;
      using actor = createTestActor(
        setup({ actors: { work } }).createMachine({
          initial: 'idle',
          states: {
            idle: { on: { RUN: 'working' } },
            working: {
              invoke: {
                src: 'work',
                input: () => ({}),
                onError: {
                  target: 'failed',
                  actions: ({ event }) => {
                    received = event.error;
                  },
                },
              },
            },
            failed: {},
          },
        }),
        { inspect: tracing.inspect },
      ).start();
      const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'error.command' });
      await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: true });
      expect(received).toBe(failure);
      expect(getSpan('failing.work').status.code).toBe(SpanStatusCode.ERROR);
      const phases = diagnostics.mock.calls.map(([diagnostic]) => diagnostic.phase);
      expect(phases.includes('resolveParentActor')).toBe(mode === 'throwing');
    },
  );

  it('falls back to the compatibility parent resolver when the configured resolver throws', async () => {
    const diagnostics = vi.fn();
    const tracing = new XStateTracing(tracer, {
      resolveParentActor: () => {
        throw new Error('resolver failed');
      },
      onTelemetryError: diagnostics,
    });
    const work = tracing.fromPromise<string, object>('resolver.work', async () => 'done');
    const child = setup({ actors: { work } }).createMachine({
      invoke: { src: 'work', input: () => ({}) },
    });
    using actor = createTestActor(
      setup({ actors: { child } }).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { RUN: 'working' } },
          working: { invoke: { src: 'child' } },
        },
      }),
      { inspect: tracing.inspect },
    ).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'resolver.command' });
    await command.finished;
    expect(getSpan('resolver.work').parentSpanContext?.spanId).toBe(command.spanId);
    expect(diagnostics).toHaveBeenCalledWith({
      phase: 'resolveParentActor',
      error: expect.any(Error),
    });
  });
});
