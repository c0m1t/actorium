import {
  assign,
  createActor,
  fromTransition,
  sendTo,
  setup,
  type AnyActorRef,
  type AnyEventObject,
} from 'xstate';
import { describe, expect, it, vi } from 'vitest';
import { XStateTracing } from '../src/index.js';
import {
  createTestActor,
  expectReleased,
  expectStoppedActorWarnings,
  internals,
  useTestTracer,
} from './helpers.js';

// Outcomes of commands whose initiating send was not counted, XState 5.33.2.
const { tracer, spans, getSpan } = useTestTracer('command-outcomes');

const outcome = 'actorium.xstate.operation.outcome';
const reason = 'actorium.xstate.operation.outcome_reason';

const counter = setup({
  types: { context: {} as { count: number } },
}).createMachine({
  context: { count: 0 },
  on: { RUN: { actions: assign({ count: ({ context }) => context.count + 1 }) } },
});

const finishing = setup({}).createMachine({
  initial: 'idle',
  states: {
    idle: {
      on: {
        FINISH: 'done',
        FAIL: {
          actions: () => {
            throw new Error('handler failed');
          },
        },
      },
    },
    done: { type: 'final' },
  },
});

const initiallyDone = setup({}).createMachine({
  initial: 'done',
  states: { done: { type: 'final' } },
});

const failingContext = setup({}).createMachine({
  context: () => {
    throw new Error('context failed');
  },
});

/** Replaces the actor's own send, delegating to the original with its receiver. */
function wrapSend(actor: AnyActorRef, before: (event: AnyEventObject) => void): void {
  const original = actor.send.bind(actor);
  actor.send = (event: AnyEventObject) => {
    before(event);
    original(event);
  };
}

describe('targets this runtime has not registered', () => {
  it('ends unobserved when an active target processes the command', async () => {
    const tracing = new XStateTracing(tracer);
    using actor = createTestActor(counter).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'foreign.active' });
    expect(actor.getSnapshot().context.count).toBe(1);
    await expect(command.finished).resolves.toEqual({ outcome: 'unobserved', hadError: false });
    const span = getSpan('foreign.active');
    expect(span.attributes[outcome]).toBe('unobserved');
    expect(span.attributes[reason]).toBe('target_not_observed');
  });

  it('fails and rethrows when the send throws', async () => {
    const tracing = new XStateTracing(tracer);
    using actor = createTestActor(counter).start();
    const failure = new Error('send failed');
    actor.send = () => {
      throw failure;
    };
    let command: ReturnType<typeof tracing.sendCommand> | undefined;
    expect(() => {
      command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'foreign.throws' });
    }).toThrow(failure);
    expect(command).toBeUndefined();
    const span = getSpan('foreign.throws');
    expect(span.attributes[outcome]).toBe('failed');
    expect(span.attributes[reason]).toBeUndefined();
  });

  it('classifies terminal targets from the snapshot alone', async () => {
    const tracing = new XStateTracing(tracer);
    using done = createTestActor(initiallyDone).start();
    using stopped = createTestActor(counter).start();
    stopped.stop();
    using transition = createTestActor(fromTransition((state) => state, {})).start();
    transition.stop();
    expect(transition.getSnapshot().status).toBe('active');

    const commands = expectStoppedActorWarnings(done, ['RUN'], () =>
      tracing.sendCommand(done, { type: 'RUN' }, { name: 'foreign.done' }),
    );
    const stoppedCommand = expectStoppedActorWarnings(stopped, ['RUN'], () =>
      tracing.sendCommand(stopped, { type: 'RUN' }, { name: 'foreign.stopped' }),
    );
    // Only the snapshot is evidence for a target this runtime never registered.
    const transitionCommand = expectStoppedActorWarnings(transition, ['RUN'], () =>
      tracing.sendCommand(transition, { type: 'RUN' }, { name: 'foreign.transition' }),
    );

    for (const command of [commands, stoppedCommand]) {
      await expect(command.finished).resolves.toEqual({
        outcome: 'target_terminal',
        hadError: false,
      });
    }
    await expect(transitionCommand.finished).resolves.toEqual({
      outcome: 'unobserved',
      hadError: false,
    });
    expect(getSpan('foreign.done').attributes[reason]).toBe('done');
    expect(getSpan('foreign.stopped').attributes[reason]).toBe('stopped');
    expect(getSpan('foreign.transition').attributes[reason]).toBe('target_not_observed');
  });
});

describe('registered terminal targets', () => {
  it('ends target_terminal with done, error or stopped', async () => {
    const tracing = new XStateTracing(tracer, { onTelemetryError: vi.fn() });
    using done = createTestActor(initiallyDone, { inspect: tracing.inspect }).start();
    using failed = createTestActor(finishing, { inspect: tracing.inspect });
    failed.subscribe({ error: () => {} });
    failed.start();
    failed.send({ type: 'FAIL' });
    expect(failed.getSnapshot().status).toBe('error');
    using transition = createTestActor(
      fromTransition((state) => state, {}),
      {
        inspect: tracing.inspect,
      },
    ).start();
    transition.stop();
    expect(transition.getSnapshot().status).toBe('active');
    await tracing.settle();

    const cases = [
      [done, 'registered.done', 'done'],
      [failed, 'registered.error', 'error'],
      [transition, 'registered.stopped', 'stopped'],
    ] as const;
    for (const [actor, name, expected] of cases) {
      const command = expectStoppedActorWarnings(actor, ['RUN'], () =>
        tracing.sendCommand(actor, { type: 'RUN' }, { name }),
      );
      await expect(command.finished).resolves.toEqual({
        outcome: 'target_terminal',
        hadError: false,
      });
      const span = getSpan(name);
      expect(span.attributes[outcome]).toBe('target_terminal');
      expect(span.attributes[reason]).toBe(expected);
      expect(span.events).toEqual([]);
      expectReleased(tracing, actor);
    }
  });

  it('accepts a command into the mailbox of a target whose initialization errored', async () => {
    const tracing = new XStateTracing(tracer, { onTelemetryError: vi.fn() });
    using target = createTestActor(failingContext, { inspect: tracing.inspect });
    expect(target.getSnapshot().status).toBe('error');
    const relay = setup({}).createMachine({
      on: { RELAY: { actions: sendTo(() => target, { type: 'WORK' }) } },
    });
    using source = createTestActor(relay, { inspect: tracing.inspect }).start();

    // Not started: XState's _send either warns and refuses or enqueues. No
    // warning (the console guard fails on one) means the event was enqueued.
    const run = { type: 'RUN' };
    const send = vi.spyOn(target, 'send');
    const command = tracing.sendCommand(target, run, { name: 'prestart.error' });
    expect(send).toHaveBeenCalledExactlyOnceWith(run);
    send.mockRestore();
    await expect(command.finished).resolves.toEqual({
      outcome: 'target_terminal',
      hadError: false,
    });
    expect(getSpan('prestart.error').attributes[reason]).toBe('error');

    const relayed = tracing.sendCommand(source, { type: 'RELAY' }, { name: 'relay.error' });
    await expect(relayed.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    const span = getSpan('relay.error');
    expect(span.attributes['actorium.xstate.operation.terminal_recipient_event_count']).toBe(1);
    expect(span.attributes[reason]).toBeUndefined();
    expect(
      span.events
        .filter((event) => event.name === 'actorium.xstate.event.recipient_terminal')
        .map((event) => event.attributes),
    ).toEqual([
      {
        'actorium.xstate.actor.id': target.id,
        'actorium.xstate.event.type': 'WORK',
        'actorium.xstate.event.terminal_reason': 'error',
      },
    ]);

    // A plain send has no operation to record it on.
    const recorded = spans().length;
    target.send({ type: 'PLAIN' });
    await tracing.settle();
    expect(spans()).toHaveLength(recorded);

    // start() discards the queued events without processing them.
    const processed: unknown[] = [];
    target.system.inspect((inspection) => {
      if (inspection.type === '@xstate.snapshot') processed.push(inspection.event.type);
    });
    target.subscribe({ error: () => {} });
    target.start();
    // An errored start emits no snapshot inspection at all.
    expect(processed).toEqual([]);
    expect(target.getSnapshot().status).toBe('error');
    await tracing.settle();
    expectReleased(tracing, target, source);
  });

  it('classifies a command named xstate.init to a terminal target', async () => {
    const tracing = new XStateTracing(tracer);
    using actor = createTestActor(counter, { inspect: tracing.inspect }).start();
    actor.stop();
    await tracing.settle();
    const command = expectStoppedActorWarnings(actor, ['xstate.init'], () =>
      tracing.sendCommand(actor, { type: 'xstate.init' }, { name: 'init.named' }),
    );
    let result: unknown;
    void command.finished.then((value) => (result = value));
    await tracing.settle();
    expect(result).toEqual({ outcome: 'target_terminal', hadError: false });
    expect(getSpan('init.named').attributes[reason]).toBe('stopped');
    expectReleased(tracing, actor);
  });

  it('ends target_terminal for a command sent from a done snapshot observer', async () => {
    // XState notifies done observers before stopping the actor, so this send
    // is queued without a warning and then discarded.
    const tracing = new XStateTracing(tracer);
    using actor = createTestActor(finishing, { inspect: tracing.inspect }).start();
    let late: ReturnType<typeof tracing.sendCommand> | undefined;
    actor.subscribe((snapshot) => {
      if (snapshot.status === 'done') {
        late = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'from.done.observer' });
      }
    });
    await expect(
      tracing.sendCommand(actor, { type: 'FINISH' }, { name: 'finish' }).finished,
    ).resolves.toEqual({ outcome: 'completed', hadError: false });
    await expect(late?.finished).resolves.toEqual({ outcome: 'target_terminal', hadError: false });
    expect(getSpan('from.done.observer').attributes[reason]).toBe('done');
    expectReleased(tracing, actor);
  });

  it('reclassifies a command whose send wrapper stops the target first', async () => {
    const tracing = new XStateTracing(tracer);
    using actor = createTestActor(counter, { inspect: tracing.inspect }).start();
    wrapSend(actor, () => actor.stop());
    const command = expectStoppedActorWarnings(actor, ['RUN'], () =>
      tracing.sendCommand(actor, { type: 'RUN' }, { name: 'wrapper.stops' }),
    );
    await expect(command.finished).resolves.toEqual({
      outcome: 'target_terminal',
      hadError: false,
    });
    expect(getSpan('wrapper.stops').attributes[reason]).toBe('stopped');
    expectReleased(tracing, actor);
  });

  it('ends unobserved when a registered target never inspects the send', async () => {
    const tracing = new XStateTracing(tracer);
    using actor = createTestActor(counter, { inspect: tracing.inspect }).start();
    actor.send = () => {};
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'send.swallowed' });
    await expect(command.finished).resolves.toEqual({ outcome: 'unobserved', hadError: false });
    expect(getSpan('send.swallowed').attributes[reason]).toBe('send_not_observed');
  });
});

describe('active targets', () => {
  it('never classifies a target that ends while handling the command as terminal', async () => {
    const tracing = new XStateTracing(tracer, { onTelemetryError: vi.fn() });
    using completing = createTestActor(finishing, { inspect: tracing.inspect }).start();
    using failing = createTestActor(finishing, { inspect: tracing.inspect });
    failing.subscribe({ error: () => {} });
    failing.start();
    await expect(
      tracing.sendCommand(completing, { type: 'FINISH' }, { name: 'ends.done' }).finished,
    ).resolves.toEqual({ outcome: 'completed', hadError: false });
    await expect(
      tracing.sendCommand(failing, { type: 'FAIL' }, { name: 'ends.error' }).finished,
    ).resolves.toEqual({ outcome: 'failed', hadError: true });
    expect(getSpan('ends.done').attributes[reason]).toBeUndefined();
    expect(getSpan('ends.error').attributes[reason]).toBeUndefined();
  });

  it('matches each command once when the same event object is sent repeatedly', async () => {
    const tracing = new XStateTracing(tracer);
    using actor = createTestActor(counter, { inspect: tracing.inspect }).start();
    const event = { type: 'RUN' };
    const commands = [1, 2, 3].map(() => tracing.sendCommand(actor, event, { name: 'same.event' }));
    for (const command of commands) {
      await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    }
    expect(actor.getSnapshot().context.count).toBe(3);
    expect(internals(tracing).pendingCommands.has(event)).toBe(false);
    expectReleased(tracing, actor);
  });

  it('keeps an outer command pending while sendCommand runs during its send', async () => {
    const tracing = new XStateTracing(tracer);
    using outer = createTestActor(counter, { inspect: tracing.inspect }).start();
    using inner = createTestActor(counter, { inspect: tracing.inspect }).start();
    const event = { type: 'RUN' };
    let nested: ReturnType<typeof tracing.sendCommand> | undefined;
    wrapSend(outer, () => {
      nested = tracing.sendCommand(inner, event, { name: 'nested' });
    });
    const command = tracing.sendCommand(outer, event, { name: 'outer' });
    await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    await expect(nested?.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(outer.getSnapshot().context.count).toBe(1);
    expect(inner.getSnapshot().context.count).toBe(1);
    expect(internals(tracing).pendingCommands.has(event)).toBe(false);
  });
});

describe('a throwing inspection observer', () => {
  it('fails a command already classified terminal and leaves others pending', async () => {
    const tracing = new XStateTracing(tracer);
    const failure = new Error('inspector failed');
    const boom = { type: 'BOOM' };
    using stopped = createTestActor(counter, { inspect: tracing.inspect }).start();
    stopped.system.inspect((inspection) => {
      if (inspection.type === '@xstate.event' && inspection.event === boom) throw failure;
    });
    stopped.stop();
    using outer = createTestActor(counter, { inspect: tracing.inspect }).start();
    const runtime = (
      tracing as unknown as { runtime: { startOperation(...args: unknown[]): unknown } }
    ).runtime;
    const started = vi.spyOn(runtime, 'startOperation');
    const run = { type: 'RUN' };
    let rethrown: unknown;
    wrapSend(outer, () => {
      try {
        tracing.sendCommand(stopped, boom, { name: 'throwing.inspector' });
      } catch (error) {
        rethrown = error;
      }
      // The failed command's record is gone; the outer one still waits for its inspection.
      expect(internals(tracing).pendingCommands.has(boom)).toBe(false);
      expect(internals(tracing).pendingCommands.has(run)).toBe(true);
      expect(internals(tracing).processing.has(stopped)).toBe(false);
    });
    const unrelated = tracing.sendCommand(outer, run, { name: 'unrelated' });

    expect(rethrown).toBe(failure);
    // The second operation started is the throwing command, inside the outer send.
    expect(started.mock.results[1]?.value).toMatchObject({ pendingDeliveries: 0, ended: true });
    started.mockRestore();
    const span = getSpan('throwing.inspector');
    expect(span.attributes[outcome]).toBe('failed');
    expect(span.attributes[reason]).toBeUndefined();
    expect(span.events.map((event) => event.name)).toEqual(['exception']);
    await expect(unrelated.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(outer.getSnapshot().context.count).toBe(1);
    expectReleased(tracing, stopped, outer);
  });
});

it('creates the actors these tests rely on with native XState semantics', () => {
  // A not-yet-started target with an errored snapshot accepts sends silently.
  const actor = createActor(failingContext);
  expect(actor.getSnapshot().status).toBe('error');
  expect(() => actor.send({ type: 'RUN' })).not.toThrow();
});
