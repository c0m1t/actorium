import type { ActorRefLike, AnyActorRef, AnyEventObject, InspectionEvent } from 'xstate';

// The only places that rely on XState behaviour outside its documented API, plus
// small structural readers for inspection payloads. Re-verify these with the
// compatibility matrix when upgrading XState.

export interface TracingClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function actorParent(actor: ActorRefLike): ActorRefLike | undefined {
  // XState's inspection event does not currently expose the creating actor.
  // Actor refs do retain it; keep this compatibility shim isolated and cover
  // it with nested-machine integration tests when upgrading XState.
  return (actor as ActorRefLike & { _parent?: ActorRefLike })._parent;
}

export function actorClock(actor: AnyActorRef): TracingClock {
  // Native Actor.clock is public; actor refs expose a narrower interface.
  return (actor as AnyActorRef & { clock: TracingClock }).clock;
}

/**
 * Public stop() is the only observable boundary for a root stopped before
 * start: XState emits no inspection or subscription notification there.
 * Delegate with the caller's receiver and arguments, then report the actor
 * that was actually stopped. XState rejects public stop() on children.
 */
export function observeRootStop(actor: AnyActorRef, stopped: (receiver: unknown) => void): void {
  const originalStop = actor.stop;
  actor.stop = function (this: unknown, ...args: unknown[]) {
    const result: unknown = Reflect.apply(originalStop, this, args);
    stopped(this);
    return result;
  } as AnyActorRef['stop'];
}

export function actorId(actor: ActorRefLike): string {
  return 'id' in actor && typeof actor.id === 'string' ? actor.id : 'unknown';
}

export function microstepStateValue(inspection: InspectionEvent): unknown {
  if (inspection.type !== '@xstate.microstep') {
    return undefined;
  }

  // XState's inspection shape has evolved: current v5 declarations expose a
  // snapshot while the public docs also describe a direct `value`. Supporting
  // both keeps this tiny diagnostic feature version-tolerant.
  const event = inspection as unknown as {
    value?: unknown;
    snapshot?: { value?: unknown };
  };

  return event.value ?? event.snapshot?.value;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isEventObject(value: unknown): value is AnyEventObject {
  return (
    value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string'
  );
}

export function asActorRefLike(value: unknown): ActorRefLike | undefined {
  const candidate = asRecord(value);
  return candidate &&
    typeof candidate.send === 'function' &&
    typeof candidate.getSnapshot === 'function'
    ? (value as ActorRefLike)
    : undefined;
}

export function timerConfigurationError(message: string, cause?: unknown): TypeError {
  return new TypeError(
    `Unsupported native timer tracing configuration: ${message}. ` +
      'Use mutable clock/scheduler data methods (XState stock clock or SimulatedClock), or omit scheduledWorkPolicy.',
    { cause },
  );
}

export function assertTimerMethodDelegation(
  target: unknown,
  label: string,
  methods: readonly string[],
): void {
  const receiver = asRecord(target);
  if (!receiver) {
    throw timerConfigurationError(`${label} must be an object with delegatable methods`);
  }
  for (const key of methods) {
    let owner: object | null = receiver;
    let descriptor: PropertyDescriptor | undefined;
    while (owner && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (!descriptor) owner = Object.getPrototypeOf(owner) as object | null;
    }
    if (
      !descriptor ||
      typeof descriptor.value !== 'function' ||
      descriptor.writable !== true ||
      (owner !== receiver && !Object.isExtensible(receiver))
    ) {
      throw timerConfigurationError(
        `${label}.${key} must allow temporary delegation as a writable function-valued data property`,
      );
    }
  }
}
