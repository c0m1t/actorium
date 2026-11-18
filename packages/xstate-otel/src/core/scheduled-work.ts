import type { ActorRefLike, AnyActorRef, AnyEventObject } from 'xstate';
import {
  actorClock,
  asActorRefLike,
  asRecord,
  assertTimerMethodDelegation,
  isEventObject,
  timerConfigurationError,
  type TracingClock,
} from '../xstate/actors.js';
import type { Diagnostics } from './diagnostics.js';
import type { Operation } from './operation.js';
import type { TelemetryLink } from './telemetry.js';
import type { LifecycleOptions, ScheduledWorkPolicyArgs, ScheduledWorkPolicy } from './types.js';

export interface ScheduledDelivery {
  readonly owner: AnyActorRef;
  readonly recipient: ActorRefLike | undefined;
  readonly event: AnyEventObject;
  readonly origin: TelemetryLink;
  readonly originOperationId: number;
  readonly policy: Readonly<ScheduledWorkPolicy>;
  readonly actionType: ScheduledWorkPolicyArgs['actionType'];
  readonly delayMs: number;
  readonly id: string | undefined;
  registration: ScheduledRegistrationQueue | undefined;
  previous: ScheduledDelivery | undefined;
  next: ScheduledDelivery | undefined;
  timeoutRecords: Map<unknown, ScheduledDelivery> | undefined;
  timeoutHandle: unknown;
}

interface ScheduledDispatch {
  readonly source: AnyActorRef;
  readonly target: AnyActorRef;
  readonly event: AnyEventObject;
  readonly scheduled: ScheduledDelivery | undefined;
}

/** Only deferred action associations waiting for their native registration. */
class ScheduledRegistrationQueue {
  private first: ScheduledDelivery | undefined;
  private last: ScheduledDelivery | undefined;
  size = 0;

  append(scheduled: ScheduledDelivery): void {
    scheduled.previous = this.last;
    if (this.last) this.last.next = scheduled;
    else this.first = scheduled;
    this.last = scheduled;
    this.size++;
  }

  remove(scheduled: ScheduledDelivery): void {
    if (scheduled.previous) scheduled.previous.next = scheduled.next;
    else this.first = scheduled.next;
    if (scheduled.next) scheduled.next.previous = scheduled.previous;
    else this.last = scheduled.previous;
    scheduled.previous = undefined;
    scheduled.next = undefined;
    this.size--;
  }

  find(target: AnyActorRef, delay: number, id: string | undefined): ScheduledDelivery | undefined {
    for (let scheduled = this.first; scheduled; scheduled = scheduled.next) {
      if (
        (scheduled.recipient === undefined || scheduled.recipient === target) &&
        scheduled.delayMs === delay &&
        scheduled.id === id
      ) {
        return scheduled;
      }
    }
    return undefined;
  }
}

/**
 * Optional native timer integration. Delayed `raise`/`sendTo` actions are
 * associated with the operation that scheduled them, then matched to the
 * scheduler registration and clock callback that delivers them.
 */
export class ScheduledWork {
  readonly instrumentedSystems: WeakSet<object> = new WeakSet();
  readonly scheduledRegistrations: WeakMap<
    ActorRefLike,
    WeakMap<object, ScheduledRegistrationQueue>
  > = new WeakMap();
  readonly scheduledByActor: WeakMap<ActorRefLike, Set<ScheduledDelivery>> = new WeakMap();
  private scheduledDispatch: ScheduledDispatch | undefined;

  private readonly policy: LifecycleOptions['scheduledWorkPolicy'];
  private readonly diagnostics: Diagnostics;
  private readonly operationForActor: (actor: ActorRefLike) => Operation | undefined;

  constructor(
    policy: LifecycleOptions['scheduledWorkPolicy'],
    diagnostics: Diagnostics,
    operationForActor: (actor: ActorRefLike) => Operation | undefined,
  ) {
    this.policy = policy;
    this.diagnostics = diagnostics;
    this.operationForActor = operationForActor;
  }

  get enabled(): boolean {
    return this.policy !== undefined;
  }

  /**
   * Returns the timer record when `event` is being delivered by a traced clock
   * callback, and `undefined` for every other delivery.
   */
  claimDispatch(
    source: unknown,
    target: ActorRefLike,
    event: AnyEventObject,
  ): { readonly scheduled: ScheduledDelivery | undefined } | undefined {
    const dispatch = this.scheduledDispatch;
    if (
      dispatch === undefined ||
      dispatch.source !== source ||
      dispatch.target !== target ||
      dispatch.event !== event
    ) {
      return undefined;
    }
    this.scheduledDispatch = undefined;
    return dispatch;
  }

  observeAction(actor: AnyActorRef, actionType: string, actionParams: unknown): void {
    const params = asRecord(actionParams);
    if (!params) {
      return;
    }

    if (
      (actionType !== 'xstate.raise' && actionType !== 'xstate.sendTo') ||
      typeof params.delay !== 'number' ||
      !isEventObject(params.event)
    ) {
      return;
    }

    const operation = this.operationForActor(actor);
    const configuredPolicy = this.policy;
    if (
      !operation ||
      operation.ended ||
      configuredPolicy === undefined ||
      !this.instrumentedSystems.has(actor.system)
    ) {
      return;
    }

    const details: ScheduledWorkPolicyArgs = {
      actor,
      actionType,
      event: params.event,
      delayMs: params.delay,
      ...(typeof params.id === 'string' ? { id: params.id } : {}),
    };
    const policy = this.diagnostics.protect<ScheduledWorkPolicy>(
      'scheduledWorkPolicy',
      () => {
        const selected =
          typeof configuredPolicy === 'function' ? configuredPolicy(details) : configuredPolicy;
        const mode = selected?.mode;
        if (mode === 'untraced') {
          return { mode };
        }
        if (mode !== 'new-linked-operation') {
          throw new TypeError('Invalid scheduled work policy');
        }
        const name = selected.name;
        if (name !== undefined && typeof name !== 'string') {
          throw new TypeError('Scheduled operation name must be a string');
        }
        // Read supported fields once, inside protection. Never retain the
        // returned object, its accessors, or extra application-owned data.
        return name === undefined ? { mode } : { mode, name };
      },
      { mode: 'untraced' },
    );
    const recipient = actionType === 'xstate.raise' ? actor : asActorRefLike(params.to);

    const scheduled: ScheduledDelivery = {
      owner: actor,
      recipient,
      event: params.event,
      origin: operation.telemetry.link(),
      originOperationId: operation.id,
      policy,
      actionType,
      delayMs: details.delayMs,
      id: typeof params.id === 'string' ? params.id : undefined,
      registration: undefined,
      previous: undefined,
      next: undefined,
      timeoutRecords: undefined,
      timeoutHandle: undefined,
    };

    const registrations = this.scheduledRegistrations.get(actor) ?? new WeakMap();
    const byEvent = registrations.get(scheduled.event) ?? new ScheduledRegistrationQueue();
    byEvent.append(scheduled);
    scheduled.registration = byEvent;
    registrations.set(scheduled.event, byEvent);
    this.scheduledRegistrations.set(actor, registrations);

    const byActor = this.scheduledByActor.get(actor) ?? new Set();
    byActor.add(scheduled);
    this.scheduledByActor.set(actor, byActor);
  }

  cancel(actor: AnyActorRef): void {
    const scheduled = this.scheduledByActor.get(actor);
    if (!scheduled) {
      return;
    }
    for (const delivery of scheduled) {
      this.remove(delivery);
    }
  }

  remove(scheduled: ScheduledDelivery): void {
    this.removeRegistration(scheduled);
    if (scheduled.timeoutRecords) {
      scheduled.timeoutRecords.delete(scheduled.timeoutHandle);
      scheduled.timeoutRecords = undefined;
      scheduled.timeoutHandle = undefined;
    }
    const byActor = this.scheduledByActor.get(scheduled.owner);
    byActor?.delete(scheduled);
    if (byActor?.size === 0) {
      this.scheduledByActor.delete(scheduled.owner);
      this.scheduledRegistrations.delete(scheduled.owner);
    }
  }

  private removeRegistration(scheduled: ScheduledDelivery): void {
    const registration = scheduled.registration;
    if (!registration) return;
    registration.remove(scheduled);
    if (registration.size === 0) {
      this.scheduledRegistrations.get(scheduled.owner)?.delete(scheduled.event);
    }
    scheduled.registration = undefined;
  }

  private takeRegistration(
    source: AnyActorRef,
    target: AnyActorRef,
    event: AnyEventObject,
    delay: number,
    id: string | undefined,
  ): ScheduledDelivery | undefined {
    // Deferred actions register in order. Search only this actor/event's
    // unregistered actions, never already pending timers or other actors.
    const registrations = this.scheduledRegistrations.get(source)?.get(event);
    const scheduled = registrations?.find(target, delay, id);
    if (scheduled) this.removeRegistration(scheduled);
    return scheduled;
  }

  /** Installs scheduler hooks once per actor system. Throws for unsupported setups. */
  instrument(actor: AnyActorRef): void {
    const system = actor.system;
    if (this.instrumentedSystems.has(system)) {
      return;
    }
    const scheduler = system.scheduler;
    const clock = actorClock(actor);
    // Validate every required method before installing any scheduler hooks.
    // Inherited data methods (SimulatedClock) need an extensible receiver.
    assertTimerMethodDelegation(scheduler, 'system.scheduler', ['schedule', 'cancel']);
    assertTimerMethodDelegation(clock, 'clock', ['setTimeout', 'clearTimeout']);
    const timeoutRecords = new Map<unknown, ScheduledDelivery>();
    const schedule = scheduler.schedule;
    scheduler.schedule = (source, target, event, delay, id) => {
      const scheduled = this.takeRegistration(source, target, event, delay, id);
      // The scheduler registers a clock callback synchronously. Decorate that
      // callback without replacing/cloning the business event or changing the
      // actor's clock outside registration. Every timer has its own closure,
      // even when several timers use the same event object and recipient.
      const setTimeout = clock.setTimeout;
      const decorateTimeout: TracingClock['setTimeout'] = (callback, delayMs) => {
        const handle = setTimeout.call(
          clock,
          () => {
            // XState removes its cancellation slot before relaying. Release our
            // handle index at the same boundary, preserving reentrant schedules.
            if (scheduled) this.remove(scheduled);
            const previous = this.scheduledDispatch;
            this.scheduledDispatch = { source, target, event, scheduled };
            try {
              callback();
            } finally {
              this.scheduledDispatch = previous;
            }
          },
          delayMs,
        );
        if (scheduled) {
          scheduled.timeoutRecords = timeoutRecords;
          scheduled.timeoutHandle = handle;
          timeoutRecords.set(handle, scheduled);
        }
        return handle;
      };
      try {
        clock.setTimeout = decorateTimeout;
      } catch (error) {
        if (scheduled) this.remove(scheduled);
        const configurationError = timerConfigurationError(
          'clock.setTimeout no longer allows method delegation',
          error,
        );
        this.diagnostics.report({ phase: 'scheduler', error: configurationError });
        throw configurationError;
      }
      try {
        return schedule.call(scheduler, source, target, event, delay, id);
      } catch (error) {
        if (scheduled) this.remove(scheduled);
        throw error;
      } finally {
        clock.setTimeout = setTimeout;
      }
    };
    const cancel = scheduler.cancel;
    scheduler.cancel = (source, id) => {
      if (timeoutRecords.size === 0) {
        return cancel.call(scheduler, source, id);
      }
      // Let the native scheduler resolve explicit/generated IDs and overlap
      // semantics. Index the exact handle it clears, with no actor-wide scan.
      const clearTimeout = clock.clearTimeout;
      const decoratedClear: TracingClock['clearTimeout'] = (handle) => {
        try {
          clearTimeout.call(clock, handle);
        } finally {
          const scheduled = timeoutRecords.get(handle);
          if (scheduled) this.remove(scheduled);
        }
      };
      try {
        clock.clearTimeout = decoratedClear;
      } catch (error) {
        const configurationError = timerConfigurationError(
          'clock.clearTimeout no longer allows method delegation',
          error,
        );
        this.diagnostics.report({ phase: 'scheduler', error: configurationError });
        throw configurationError;
      }
      try {
        return cancel.call(scheduler, source, id);
      } finally {
        clock.clearTimeout = clearTimeout;
      }
    };
    // Native cancelAll cancels each timer through scheduler.cancel above.
    this.instrumentedSystems.add(system);
  }
}
