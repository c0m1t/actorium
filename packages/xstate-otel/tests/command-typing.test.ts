import { trace } from '@opentelemetry/api';
import { setup, type ActorRefFrom, type AnyActorRef, type AnyEventObject } from 'xstate';
import { expect, expectTypeOf, it } from 'vitest';
import { XStateTracing, type CommandEvent } from '../src/index.js';
import { createTestActor } from './helpers.js';

// Compile-time coverage: `sendCommand` follows the target actor's event union.
const tracing = new XStateTracing(trace.getTracer('command-typing'));

const machine = setup({
  types: {} as { events: { type: 'START'; id: string } | { type: 'STOP' } },
}).createMachine({ initial: 'idle', states: { idle: {} } });

it('constrains command events to the typed actor and keeps untyped callers open', () => {
  using actor = createTestActor(machine).start();
  const options = { name: 'typing' };

  tracing.sendCommand(actor, { type: 'START', id: 'a' }, options);
  tracing.sendCommand(actor, { type: 'STOP' }, options);

  // @ts-expect-error Unknown event types are rejected like `actor.send`.
  tracing.sendCommand(actor, { type: 'TYPO' }, options);
  // @ts-expect-error Required event fields remain checked.
  tracing.sendCommand(actor, { type: 'START' }, options);
  // @ts-expect-error Event field types remain checked.
  tracing.sendCommand(actor, { type: 'START', id: 1 }, options);

  // Refs typed from the machine (for example stored children) are constrained too.
  const ref: ActorRefFrom<typeof machine> = actor;
  expectTypeOf<CommandEvent<typeof ref>>().toEqualTypeOf<CommandEvent<typeof actor>>();
  // @ts-expect-error Unknown event types are rejected for machine-typed refs.
  tracing.sendCommand(ref, { type: 'TYPO' }, options);

  const untyped: AnyActorRef = actor;
  tracing.sendCommand(untyped, { type: 'ANYTHING' }, options);
  const anyEvent: AnyEventObject = { type: 'DYNAMIC' };
  tracing.sendCommand(untyped, anyEvent, options);

  // Invalid commands are type-checked only; calling them would fail at runtime.
  const rejectedAtCompileTime = () => {
    // @ts-expect-error Untyped targets still require an event object.
    tracing.sendCommand(untyped, 'START', options);
    // @ts-expect-error Null is not an event object.
    tracing.sendCommand(untyped, null, options);
    // @ts-expect-error An event object needs a string `type`.
    tracing.sendCommand(untyped, {}, options);
  };
  expect(rejectedAtCompileTime).toBeTypeOf('function');

  const eventOf: CommandEvent<typeof actor> = { type: 'STOP' };
  expect(eventOf.type).toBe('STOP');
});
