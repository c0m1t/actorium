import {
  createActor,
  forwardTo,
  fromPromise,
  fromTransition,
  raise,
  sendParent,
  sendTo,
  setup,
  SimulatedClock,
  type AnyActorRef,
  type InspectionEvent,
} from 'xstate';
import { describe, expect, it, vi } from 'vitest';
import { XStateTracing, type OperationResult } from '../src/index.js';
import { deferred, useTestTracer } from './helpers.js';

// The send matrix: how XState delivers an event to a target in each state,
// and what xstate-otel records for it. The compatibility matrix runs it on
// every tested XState version. Each table is a single assertion, so a change
// in XState or in the runtime shows up as a diff of the matrix.
const { tracer, spans, spansNamed } = useTestTracer('send-matrix');

const outcome = 'actorium.xstate.operation.outcome';
const reason = 'actorium.xstate.operation.outcome_reason';
const terminalRecipientCount = 'actorium.xstate.operation.terminal_recipient_event_count';
const recipientTerminal = 'actorium.xstate.event.recipient_terminal';
const terminalReason = 'actorium.xstate.event.terminal_reason';
const microstep = 'actorium.xstate.microstep';
const actorIdKey = 'actorium.xstate.actor.id';
const eventTypeKey = 'actorium.xstate.event.type';

const targetStates = [
  'not started, active',
  'not started, error',
  'not started, done',
  'stopped before start',
  'running, idle',
  'running, busy',
  'done after start',
  'errored after start',
  'root stopped after start',
  'child stopped by parent',
  'transition actor stopped',
] as const;
type TargetState = (typeof targetStates)[number];
type Inspect = (inspection: InspectionEvent) => void;

function targetLogic(
  processed: string[],
  hooks: { kick: () => void },
  options: { initial?: 'idle' | 'done'; failingContext?: boolean } = {},
) {
  return setup({}).createMachine({
    context: () => {
      if (options.failingContext) throw new Error('context failed');
      return {};
    },
    initial: options.initial ?? 'idle',
    states: {
      idle: {
        on: {
          PING: { actions: () => processed.push('PING') },
          KICK: { actions: () => hooks.kick() },
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
}

interface Target {
  readonly actor: AnyActorRef;
  /** Event types the target has processed. */
  readonly processed: string[];
  /** Whether the event was processed before the busy target finished its current event. */
  readonly processedWhileBusy: boolean | undefined;
  /** A target that can still be started. */
  readonly notStarted: boolean;
  /** Runs the send; the busy target runs it while it processes another event. */
  deliver(send: () => void): void;
  start(): void;
  stop(): void;
}

/** Creates a target in the given state; `inspect` registers it with a tracing instance. */
function createTarget(state: TargetState, inspect?: Inspect): Target {
  const processed: string[] = [];
  const hooks = { kick: () => {} };
  // Root targets share the child's ID, so span events can name the target.
  const options = inspect ? { id: 'target', inspect } : { id: 'target' };
  const ignoreErrors = (actor: AnyActorRef) => actor.subscribe({ error: () => {} });
  let notStarted = false;
  let processedWhileBusy: boolean | undefined;
  let owner: AnyActorRef | undefined;
  let actor: AnyActorRef;
  let deliver = (send: () => void) => send();
  switch (state) {
    case 'not started, active':
      actor = createActor(targetLogic(processed, hooks), options);
      notStarted = true;
      break;
    case 'not started, error':
      actor = createActor(targetLogic(processed, hooks, { failingContext: true }), options);
      ignoreErrors(actor);
      notStarted = true;
      break;
    case 'not started, done':
      actor = createActor(targetLogic(processed, hooks, { initial: 'done' }), options);
      notStarted = true;
      break;
    case 'stopped before start':
      actor = createActor(targetLogic(processed, hooks), options);
      actor.stop();
      break;
    case 'running, idle':
      actor = createActor(targetLogic(processed, hooks), options).start();
      break;
    case 'running, busy':
      actor = createActor(targetLogic(processed, hooks), options).start();
      deliver = (send) => {
        hooks.kick = () => {
          send();
          processedWhileBusy = processed.length > 0;
        };
        actor.send({ type: 'KICK' });
      };
      break;
    case 'done after start':
      actor = createActor(targetLogic(processed, hooks), options).start();
      actor.send({ type: 'FINISH' });
      break;
    case 'errored after start':
      actor = createActor(targetLogic(processed, hooks), options);
      ignoreErrors(actor);
      actor.start();
      actor.send({ type: 'FAIL' });
      break;
    case 'root stopped after start':
      actor = createActor(targetLogic(processed, hooks), options).start();
      actor.stop();
      break;
    case 'child stopped by parent': {
      const parent = setup({ actors: { target: targetLogic(processed, hooks) } }).createMachine({
        initial: 'on',
        states: { on: { invoke: { id: 'target', src: 'target' }, on: { OFF: 'off' } }, off: {} },
      });
      owner = createActor(parent, options).start();
      actor = owner.getSnapshot().children.target as AnyActorRef;
      owner.send({ type: 'OFF' });
      break;
    }
    case 'transition actor stopped':
      actor = createActor(
        fromTransition((snapshot, event) => {
          if (event.type === 'PING') processed.push('PING');
          return snapshot;
        }, {}),
        options,
      ).start();
      actor.stop();
      break;
  }
  return {
    actor,
    processed,
    get processedWhileBusy() {
      return processedWhileBusy;
    },
    notStarted,
    deliver,
    start: () => actor.start(),
    // A child is stopped through its parent.
    stop: () => (owner ?? actor).stop(),
  };
}

/** What happened to the event, starting a target that was not started yet. */
function deliveryOf(target: Target): string {
  if (target.processed.length > 0) {
    return target.processedWhileBusy === false
      ? 'queued, processed after the current event'
      : 'processed';
  }
  if (!target.notStarted) return 'refused';
  target.start();
  return target.processed.length > 0 ? 'queued, processed at start' : 'queued, discarded at start';
}

/**
 * Runs `body` with console.warn captured and returns how many XState
 * stopped-actor warnings it printed for PING; any other warning fails.
 */
async function countingWarnings<T>(body: () => T | Promise<T>): Promise<[T, number]> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = await body();
    for (const [message] of warn.mock.calls) {
      expect(String(message)).toMatch(/^Event "PING" was sent to stopped actor /);
    }
    return [result, warn.mock.calls.length];
  } finally {
    warn.mockRestore();
  }
}

function relaySender(target: AnyActorRef, relay: 'sendTo' | 'forwardTo', inspect?: Inspect) {
  const action =
    relay === 'sendTo' ? sendTo(() => target, { type: 'PING' }) : forwardTo(() => target);
  return createActor(
    setup({}).createMachine({ on: { PING: { actions: action } } }),
    inspect ? { id: 'sender', inspect } : { id: 'sender' },
  ).start();
}

function forEachState<T>(row: (state: TargetState) => T): Record<TargetState, T> {
  return Object.fromEntries(targetStates.map((state) => [state, row(state)])) as Record<
    TargetState,
    T
  >;
}

async function forEachStateAsync<T>(
  row: (state: TargetState) => Promise<T>,
): Promise<Record<TargetState, T>> {
  const rows: [TargetState, T][] = [];
  for (const state of targetStates) rows.push([state, await row(state)]);
  return Object.fromEntries(rows) as Record<TargetState, T>;
}

describe('XState', () => {
  // The same for every send mechanism; only the inspecting system differs.
  const native: Record<TargetState, { status: string; delivery: string; warnings: number }> = {
    'not started, active': {
      status: 'active',
      delivery: 'queued, processed at start',
      warnings: 0,
    },
    'not started, error': { status: 'error', delivery: 'queued, discarded at start', warnings: 0 },
    'not started, done': { status: 'done', delivery: 'queued, discarded at start', warnings: 0 },
    'stopped before start': { status: 'active', delivery: 'refused', warnings: 1 },
    'running, idle': { status: 'active', delivery: 'processed', warnings: 0 },
    'running, busy': {
      status: 'active',
      delivery: 'queued, processed after the current event',
      warnings: 0,
    },
    'done after start': { status: 'done', delivery: 'refused', warnings: 1 },
    'errored after start': { status: 'error', delivery: 'refused', warnings: 1 },
    'root stopped after start': { status: 'stopped', delivery: 'refused', warnings: 1 },
    'child stopped by parent': { status: 'stopped', delivery: 'refused', warnings: 1 },
    'transition actor stopped': { status: 'active', delivery: 'refused', warnings: 1 },
  };

  it.each([
    ['actor.send', 'target system'],
    ['sendTo', 'sender system'],
    ['forwardTo', 'sender system'],
  ] as const)('delivers %s the same way in every target state', async (mechanism, inspectedBy) => {
    const rows = await forEachStateAsync(async (state) => {
      const target = createTarget(state);
      const sender = mechanism === 'actor.send' ? undefined : relaySender(target.actor, mechanism);
      const inspected = new Set<string>();
      const observe = (system: string) => (inspection: InspectionEvent) => {
        if (inspection.type === '@xstate.event' && inspection.actorRef === target.actor) {
          if (inspection.event.type === 'PING') inspected.add(system);
        }
      };
      target.actor.system.inspect(observe('target system'));
      sender?.system.inspect(observe('sender system'));
      const status = target.actor.getSnapshot().status as string;
      const [delivery, warnings] = await countingWarnings(() => {
        // XState never throws here; a throw fails the test.
        target.deliver(() =>
          sender ? sender.send({ type: 'PING' }) : target.actor.send({ type: 'PING' }),
        );
        return deliveryOf(target);
      });
      sender?.stop();
      target.stop();
      return { status, delivery, warnings, inspectedBy: [...inspected] };
    });
    expect(rows).toEqual(
      forEachState((state) => ({ ...native[state], inspectedBy: [inspectedBy] })),
    );
  });

  it('delivers raised, parent, completion and delayed events', async () => {
    const rows: Record<string, { inspected: boolean; processed: boolean; warnings: number }> = {};
    const record = async (
      name: string,
      run: (inspect: Inspect, processed: string[]) => void | Promise<void>,
    ) => {
      const processed: string[] = [];
      let inspected = false;
      const inspect: Inspect = (inspection) => {
        if (inspection.type === '@xstate.event' && inspection.event.type !== 'xstate.init') {
          if (!['GO', 'RUN', 'OFF'].includes(inspection.event.type)) inspected = true;
        }
      };
      const [, warnings] = await countingWarnings(() => run(inspect, processed));
      rows[name] = { inspected, processed: processed.length > 0, warnings };
    };

    await record('raise, no delay', (inspect, processed) => {
      const actor = createActor(
        setup({}).createMachine({
          on: {
            GO: { actions: raise({ type: 'PING' }) },
            PING: { actions: () => processed.push('PING') },
          },
        }),
        { inspect },
      ).start();
      actor.send({ type: 'GO' });
      actor.stop();
    });

    await record('sendParent to a running parent', (inspect, processed) => {
      const child = setup({}).createMachine({ entry: sendParent({ type: 'PING' }) });
      const parent = createActor(
        setup({ actors: { child } }).createMachine({
          invoke: { src: 'child' },
          on: { PING: { actions: () => processed.push('PING') } },
        }),
        { inspect },
      ).start();
      parent.stop();
    });

    for (const parentStopped of [false, true]) {
      const name = parentStopped
        ? 'completion notification, parent stopped first'
        : 'completion notification, parent running';
      await record(name, async (inspect, processed) => {
        const work = deferred<string>();
        const parent = createActor(
          setup({ actors: { work: fromPromise(() => work.promise) } }).createMachine({
            invoke: { src: 'work', onDone: { actions: () => processed.push('done') } },
          }),
          { inspect },
        ).start();
        if (parentStopped) parent.stop();
        work.resolve('result');
        await work.promise;
        await Promise.resolve();
        parent.stop();
      });
    }

    for (const variant of ['target running', 'target stopped first', 'sender stopped first']) {
      await record(`delayed sendTo, ${variant}`, (inspect, processed) => {
        const target = createTarget('running, idle');
        const clock = new SimulatedClock();
        const sender = createActor(
          setup({}).createMachine({
            on: { GO: { actions: sendTo(() => target.actor, { type: 'PING' }, { delay: 10 }) } },
          }),
          { inspect, clock },
        ).start();
        sender.send({ type: 'GO' });
        if (variant === 'target stopped first') target.stop();
        if (variant === 'sender stopped first') sender.stop();
        clock.increment(10);
        processed.push(...target.processed);
        sender.stop();
        target.stop();
      });
    }

    expect(rows).toEqual({
      'raise, no delay': { inspected: false, processed: true, warnings: 0 },
      'sendParent to a running parent': { inspected: true, processed: true, warnings: 0 },
      'completion notification, parent running': { inspected: true, processed: true, warnings: 0 },
      'completion notification, parent stopped first': {
        inspected: false,
        processed: false,
        warnings: 0,
      },
      'delayed sendTo, target running': { inspected: true, processed: true, warnings: 0 },
      'delayed sendTo, target stopped first': { inspected: true, processed: false, warnings: 1 },
      'delayed sendTo, sender stopped first': { inspected: false, processed: false, warnings: 0 },
    });
  });
});

interface OperationRow {
  /** The outcome before a target that was not started yet is started, when it differs. */
  beforeStart?: string;
  outcome: string;
  reason?: string | undefined;
  processed: boolean;
}

/** Tracks a command's result without awaiting it, since some stay open until the target starts. */
function track(command: { finished: Promise<OperationResult> }) {
  let result: OperationResult | undefined;
  void command.finished.then((value) => (result = value));
  return () => result?.outcome ?? 'open';
}

describe('xstate-otel', () => {
  it.each([
    ['inspected by the tracing', true],
    ['not inspected', false],
  ] as const)('ends sendCommand to a target %s', async (_, inspected) => {
    const rows = await forEachStateAsync(async (state) => {
      const tracing = new XStateTracing(tracer, { onDiagnostic: () => {} });
      const target = createTarget(state, inspected ? tracing.inspect : undefined);
      const name = `command ${state} ${inspected}`;
      const [row] = await countingWarnings(async () => {
        let result = () => 'not sent';
        target.deliver(() => {
          result = track(tracing.sendCommand(target.actor, { type: 'PING' }, { name }));
        });
        await tracing.waitForBookkeeping();
        const beforeStart = result();
        deliveryOf(target);
        await tracing.waitForBookkeeping();
        const row: OperationRow = {
          outcome: result(),
          reason: spansNamed(name)[0]?.attributes[reason] as string | undefined,
          processed: target.processed.length > 0,
        };
        if (beforeStart !== row.outcome) row.beforeStart = beforeStart;
        return row;
      });
      target.stop();
      return row;
    });
    const terminal = (terminalReason: string) => ({
      outcome: 'target_terminal',
      reason: terminalReason,
      processed: false,
    });
    const unobserved = (processed: boolean) => ({
      outcome: 'unobserved',
      reason: 'target_not_observed',
      processed,
    });
    const completed = { outcome: 'completed', processed: true };
    expect(rows).toEqual(
      inspected
        ? {
            // Counted, so the operation stays open until the target starts.
            'not started, active': { beforeStart: 'open', ...completed },
            'not started, error': terminal('error'),
            'not started, done': terminal('done'),
            'stopped before start': terminal('stopped'),
            'running, idle': completed,
            'running, busy': completed,
            'done after start': terminal('done'),
            'errored after start': terminal('error'),
            'root stopped after start': terminal('stopped'),
            'child stopped by parent': terminal('stopped'),
            'transition actor stopped': terminal('stopped'),
          }
        : {
            'not started, active': unobserved(true),
            'not started, error': terminal('error'),
            'not started, done': terminal('done'),
            // Only the snapshot is evidence, and it is still active.
            'stopped before start': unobserved(false),
            'running, idle': unobserved(true),
            'running, busy': unobserved(true),
            'done after start': terminal('done'),
            'errored after start': terminal('error'),
            'root stopped after start': terminal('stopped'),
            'child stopped by parent': terminal('stopped'),
            'transition actor stopped': unobserved(false),
          },
    );
  });

  it.each([
    ['sendTo', 'inspected by the tracing', true],
    ['sendTo', 'not inspected', false],
    ['forwardTo', 'inspected by the tracing', true],
    ['forwardTo', 'not inspected', false],
  ] as const)('records a %s relay to a target %s', async (relay, _, inspected) => {
    const rows = await forEachStateAsync(async (state) => {
      const tracing = new XStateTracing(tracer, {
        onDiagnostic: () => {},
        recordMicrosteps: true,
      });
      const target = createTarget(state, inspected ? tracing.inspect : undefined);
      const sender = relaySender(target.actor, relay, tracing.inspect);
      const name = `${relay} ${state} ${inspected}`;
      const [row] = await countingWarnings(async () => {
        let result = () => 'not sent';
        target.deliver(() => {
          result = track(tracing.sendCommand(sender, { type: 'PING' }, { name }));
        });
        await tracing.waitForBookkeeping();
        const beforeStart = result();
        deliveryOf(target);
        await tracing.waitForBookkeeping();
        const span = spansNamed(name)[0];
        const row = {
          outcome: result(),
          terminalRecipients: span?.attributes[terminalRecipientCount],
          terminalReasons: span?.events
            .filter((event) => event.name === recipientTerminal)
            .map((event) => event.attributes?.[terminalReason]),
          processed: target.processed.length > 0,
          // The recipient's processing joined the relay's operation.
          recipientMicrosteps: span?.events.filter(
            (event) =>
              event.name === microstep &&
              event.attributes?.[actorIdKey] === 'target' &&
              event.attributes[eventTypeKey] === 'PING',
          ).length,
          ...(beforeStart === result() ? {} : { beforeStart }),
        };
        return row;
      });
      sender.stop();
      target.stop();
      return row;
    });
    const counted = {
      outcome: 'completed',
      terminalReasons: [],
      processed: true,
      recipientMicrosteps: 1,
    };
    const terminal = (terminalReason: string) => ({
      outcome: 'completed',
      terminalRecipients: 1,
      terminalReasons: [terminalReason],
      processed: false,
      recipientMicrosteps: 0,
    });
    const ignored = (processed: boolean) => ({
      outcome: 'completed',
      terminalReasons: [],
      processed,
      recipientMicrosteps: 0,
    });
    expect(rows).toEqual(
      inspected
        ? {
            // Counted, so the operation stays open until the target starts.
            'not started, active': { beforeStart: 'open', ...counted },
            'not started, error': terminal('error'),
            'not started, done': terminal('done'),
            'stopped before start': terminal('stopped'),
            'running, idle': counted,
            'running, busy': counted,
            'done after start': terminal('done'),
            'errored after start': terminal('error'),
            'root stopped after start': terminal('stopped'),
            'child stopped by parent': terminal('stopped'),
            'transition actor stopped': terminal('stopped'),
          }
        : // A target in another actor system is invisible to this tracing.
          {
            'not started, active': ignored(true),
            'not started, error': ignored(false),
            'not started, done': ignored(false),
            'stopped before start': ignored(false),
            'running, idle': ignored(true),
            'running, busy': ignored(true),
            'done after start': ignored(false),
            'errored after start': ignored(false),
            'root stopped after start': ignored(false),
            'child stopped by parent': ignored(false),
            'transition actor stopped': ignored(false),
          },
    );
  });

  it('records plain sends, stops before start, completion notifications and timers', async () => {
    const rows: Record<string, unknown> = {};

    for (const state of ['running, idle', 'done after start'] as const) {
      const tracing = new XStateTracing(tracer, { onDiagnostic: () => {} });
      const target = createTarget(state, tracing.inspect);
      const before = spans().length;
      await countingWarnings(async () => {
        target.actor.send({ type: 'PING' });
        await tracing.waitForBookkeeping();
      });
      rows[`plain send, ${state}`] = { operations: spans().length - before };
      target.stop();
    }

    for (const via of ['sendCommand', 'sendTo'] as const) {
      const tracing = new XStateTracing(tracer, { onDiagnostic: () => {} });
      const target = createTarget('not started, active', tracing.inspect);
      const sender = relaySender(target.actor, 'sendTo', tracing.inspect);
      const command = tracing.sendCommand(
        via === 'sendTo' ? sender : target.actor,
        { type: 'PING' },
        { name: `${via} before stop` },
      );
      const result = track(command);
      await tracing.waitForBookkeeping();
      const beforeStop = result();
      target.stop();
      rows[`${via} to an observed actor stopped before it starts`] = {
        beforeStop,
        outcome: (await command.finished).outcome,
      };
      sender.stop();
    }

    {
      // The stop abandons only that delivery; the operation still waits for
      // its other work, whose failure decides the outcome.
      const tracing = new XStateTracing(tracer, { onDiagnostic: () => {} });
      const target = createTarget('not started, active', tracing.inspect);
      const work = deferred<string>();
      const sender = createActor(
        setup({
          actors: { work: tracing.fromPromise<string, object>('work', () => work.promise) },
        }).createMachine({
          initial: 'idle',
          states: {
            idle: {
              on: {
                PING: { target: 'working', actions: sendTo(() => target.actor, { type: 'PING' }) },
              },
            },
            working: { invoke: { src: 'work', input: {} } },
          },
        }),
        { id: 'sender', inspect: tracing.inspect },
      );
      sender.subscribe({ error: () => {} });
      sender.start();
      const command = tracing.sendCommand(sender, { type: 'PING' }, { name: 'relay and work' });
      const result = track(command);
      await tracing.waitForBookkeeping();
      target.stop();
      await tracing.waitForBookkeeping();
      const afterStop = result();
      work.reject(new Error('work failed'));
      rows['sendTo to an observed actor stopped before it starts, then the sender fails'] = {
        afterStop,
        outcome: (await command.finished).outcome,
      };
      sender.stop();
    }

    for (const parentStopped of [false, true]) {
      const tracing = new XStateTracing(tracer, { onDiagnostic: () => {} });
      const work = deferred<string>();
      const parent = createActor(
        setup({
          actors: { work: tracing.fromPromise<string, object>('work', () => work.promise) },
        }).createMachine({
          initial: 'idle',
          states: {
            idle: { on: { RUN: 'working' } },
            working: { invoke: { src: 'work', input: {}, onDone: 'idle' } },
          },
        }),
        { inspect: tracing.inspect },
      ).start();
      const command = tracing.sendCommand(parent, { type: 'RUN' }, { name: 'with work' });
      const whileWorking = track(command);
      await tracing.waitForBookkeeping();
      const open = whileWorking();
      if (parentStopped) parent.stop();
      work.resolve('result');
      const { outcome: finalOutcome } = await command.finished;
      rows[
        parentStopped
          ? 'completion notification, parent stopped first'
          : 'completion notification, parent running'
      ] = { whileWorking: open, outcome: finalOutcome };
      parent.stop();
    }

    for (const variant of ['target running', 'target stopped first', 'sender stopped first']) {
      const tracing = new XStateTracing(tracer, {
        onDiagnostic: () => {},
        timerPolicy: { mode: 'new-linked-operation', name: 'timer' },
      });
      const target = createTarget('running, idle', tracing.inspect);
      const clock = new SimulatedClock();
      const sender = createActor(
        setup({}).createMachine({
          on: { GO: { actions: sendTo(() => target.actor, { type: 'PING' }, { delay: 10 }) } },
        }),
        { inspect: tracing.inspect, clock },
      ).start();
      await tracing.sendCommand(sender, { type: 'GO' }, { name: 'schedule' }).finished;
      const before = spansNamed('timer').length;
      await countingWarnings(async () => {
        if (variant === 'target stopped first') target.stop();
        if (variant === 'sender stopped first') sender.stop();
        clock.increment(10);
        await tracing.waitForBookkeeping();
      });
      rows[`delayed sendTo, ${variant}`] = {
        timerOperations: spansNamed('timer')
          .slice(before)
          .map((span) => span.attributes[outcome]),
      };
      sender.stop();
      target.stop();
    }

    expect(rows).toEqual({
      'plain send, running, idle': { operations: 0 },
      'plain send, done after start': { operations: 0 },
      'sendCommand to an observed actor stopped before it starts': {
        beforeStop: 'open',
        outcome: 'cancelled',
      },
      'sendTo to an observed actor stopped before it starts': {
        beforeStop: 'open',
        outcome: 'cancelled',
      },
      'sendTo to an observed actor stopped before it starts, then the sender fails': {
        afterStop: 'open',
        outcome: 'failed',
      },
      'completion notification, parent running': { whileWorking: 'open', outcome: 'completed' },
      'completion notification, parent stopped first': {
        whileWorking: 'open',
        outcome: 'cancelled',
      },
      'delayed sendTo, target running': { timerOperations: ['completed'] },
      'delayed sendTo, target stopped first': { timerOperations: [] },
      'delayed sendTo, sender stopped first': { timerOperations: [] },
    });
  });
});
