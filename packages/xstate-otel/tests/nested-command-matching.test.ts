import { setup, type AnyActorRef, type AnyEventObject, type InspectionEvent } from 'xstate';
import { describe, expect, it } from 'vitest';
import { XStateTracing } from '../src/index.js';
import { createTestActor, expectReleased, internals, useTestTracer } from './helpers.js';

// One event object sent twice to one actor, the second send nested inside the
// first. XState 5.33.2 accepts the nested send first, so it is processed first:
// its inspection, then every inspection observer, then the actor's mailbox.
const { tracer, getSpan } = useTestTracer('nested-command-matching');

const stepper = setup({}).createMachine({
  initial: 'zero',
  states: {
    zero: { on: { RUN: 'one' } },
    one: { on: { RUN: 'two' } },
    two: {},
  },
});

type Placement = 'send wrapper' | 'earlier inspector' | 'later inspector';

/** State values recorded by each command's microsteps: its processing owner. */
function owned(name: string): unknown[] {
  return getSpan(name)
    .events.filter((event) => event.name === 'actorium.xstate.microstep')
    .map((event) => event.attributes?.['actorium.xstate.state.value']);
}

async function nested(placement: Placement, expected: { inner: unknown[]; outer: unknown[] }) {
  const tracing = new XStateTracing(tracer, { recordMicrosteps: true });
  const event = { type: 'RUN' };
  let inner: ReturnType<typeof tracing.sendCommand> | undefined;
  let armed = false;
  const nest = (actor: AnyActorRef) => {
    if (!armed) return;
    armed = false;
    inner = tracing.sendCommand(actor, event, { name: 'inner' });
  };
  const onRelay = (inspection: InspectionEvent) => {
    if (inspection.type === '@xstate.event' && inspection.event === event) {
      nest(inspection.actorRef as AnyActorRef);
    }
  };
  using actor = createTestActor(stepper, {
    inspect: (inspection) => {
      if (placement === 'earlier inspector') onRelay(inspection);
      tracing.inspect(inspection);
    },
  }).start();
  if (placement === 'later inspector') actor.system.inspect(onRelay);
  if (placement === 'send wrapper') {
    const send = actor.send.bind(actor);
    actor.send = (sent: AnyEventObject) => {
      nest(actor);
      send(sent);
    };
  }
  armed = true;
  const outer = tracing.sendCommand(actor, event, { name: 'outer' });
  await expect(inner?.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  await expect(outer.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  expect(actor.getSnapshot().value).toBe('two');
  expect(owned('inner')).toEqual(expected.inner);
  expect(owned('outer')).toEqual(expected.outer);
  expect(internals(tracing).pendingCommands.has(event)).toBe(false);
  expectReleased(tracing, actor);
}

describe('a command nested in another send of the same event object to the same actor', () => {
  it.each<Placement>(['send wrapper', 'earlier inspector'])(
    'owns the delivery XState processes for it, from a %s',
    (placement) => nested(placement, { inner: ['one'], outer: ['two'] }),
  );

  it('swaps processing owners from a later inspector, a documented gap', () =>
    // The outer delivery is mirrored before the nested one, but XState accepts
    // the nested one first. Only private Actor._send would reveal acceptance.
    nested('later inspector', { inner: ['two'], outer: ['one'] }));
});
