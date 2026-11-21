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
import type { LifecycleOptions, TimerPolicyArgs, TimerPolicy } from './types.js';

export interface TimerRegistration {
  readonly owner: AnyActorRef;
  readonly recipient: ActorRefLike | undefined;
  readonly event: AnyEventObject;
  readonly origin: TelemetryLink;
  readonly originOperationId: number;
  readonly policy: Readonly<TimerPolicy>;
  readonly actionType: TimerPolicyArgs['actionType'];
  readonly delayMs: number;
  readonly id: string | undefined;
  registration: TimerRegistrationQueue | undefined;
  previous: TimerRegistration | undefined;
  next: TimerRegistration | undefined;
  timeoutRecords: Map<unknown, TimerRegistration> | undefined;
  timeoutHandle: unknown;
}

interface TimerDispatch {
  readonly source: AnyActorRef;
  readonly target: AnyActorRef;
  readonly event: AnyEventObject;
  readonly timer: TimerRegistration | undefined;
}

/** Only deferred action associations waiting for their native registration. */
class TimerRegistrationQueue {
  private first: TimerRegistration | undefined;
  private last: TimerRegistration | undefined;
  size = 0;

  append(timer: TimerRegistration): void {
    timer.previous = this.last;
    if (this.last) this.last.next = timer;
    else this.first = timer;
    this.last = timer;
    this.size++;
  }

  remove(timer: TimerRegistration): void {
    if (timer.previous) timer.previous.next = timer.next;
    else this.first = timer.next;
    if (timer.next) timer.next.previous = timer.previous;
    else this.last = timer.previous;
    timer.previous = undefined;
    timer.next = undefined;
    this.size--;
  }

  find(target: AnyActorRef, delay: number, id: string | undefined): TimerRegistration | undefined {
    for (let timer = this.first; timer; timer = timer.next) {
      if (
        (timer.recipient === undefined || timer.recipient === target) &&
        timer.delayMs === delay &&
        timer.id === id
      ) {
        return timer;
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
export class TimerIntegration {
  readonly instrumentedSystems: WeakSet<object> = new WeakSet();
  readonly timerRegistrations: WeakMap<ActorRefLike, WeakMap<object, TimerRegistrationQueue>> =
    new WeakMap();
  readonly timersByActor: WeakMap<ActorRefLike, Set<TimerRegistration>> = new WeakMap();
  private activeDispatch: TimerDispatch | undefined;

  private readonly policy: LifecycleOptions['timerPolicy'];
  private readonly diagnostics: Diagnostics;
  private readonly operationForActor: (actor: ActorRefLike) => Operation | undefined;

  constructor(
    policy: LifecycleOptions['timerPolicy'],
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
  ): { readonly timer: TimerRegistration | undefined } | undefined {
    const dispatch = this.activeDispatch;
    if (
      dispatch === undefined ||
      dispatch.source !== source ||
      dispatch.target !== target ||
      dispatch.event !== event
    ) {
      return undefined;
    }
    this.activeDispatch = undefined;
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

    const details: TimerPolicyArgs = {
      actor,
      actionType,
      event: params.event,
      delayMs: params.delay,
      ...(typeof params.id === 'string' ? { id: params.id } : {}),
    };
    const policy = this.diagnostics.protect<TimerPolicy>(
      'timerPolicy',
      () => {
        const selected =
          typeof configuredPolicy === 'function' ? configuredPolicy(details) : configuredPolicy;
        const mode = selected?.mode;
        if (mode === 'untraced') {
          return { mode };
        }
        if (mode !== 'new-linked-operation') {
          throw new TypeError('Invalid timer policy');
        }
        const name = selected.name;
        if (name !== undefined && typeof name !== 'string') {
          throw new TypeError('Timer operation name must be a string');
        }
        // Read supported fields once, inside protection. Never retain the
        // returned object, its accessors, or extra application-owned data.
        return name === undefined ? { mode } : { mode, name };
      },
      { mode: 'untraced' },
    );
    const recipient = actionType === 'xstate.raise' ? actor : asActorRefLike(params.to);

    const timer: TimerRegistration = {
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

    const registrations = this.timerRegistrations.get(actor) ?? new WeakMap();
    const byEvent = registrations.get(timer.event) ?? new TimerRegistrationQueue();
    byEvent.append(timer);
    timer.registration = byEvent;
    registrations.set(timer.event, byEvent);
    this.timerRegistrations.set(actor, registrations);

    const byActor = this.timersByActor.get(actor) ?? new Set();
    byActor.add(timer);
    this.timersByActor.set(actor, byActor);
  }

  cancel(actor: AnyActorRef): void {
    const timer = this.timersByActor.get(actor);
    if (!timer) {
      return;
    }
    for (const delivery of timer) {
      this.remove(delivery);
    }
  }

  remove(timer: TimerRegistration): void {
    this.removeRegistration(timer);
    if (timer.timeoutRecords) {
      timer.timeoutRecords.delete(timer.timeoutHandle);
      timer.timeoutRecords = undefined;
      timer.timeoutHandle = undefined;
    }
    const byActor = this.timersByActor.get(timer.owner);
    byActor?.delete(timer);
    if (byActor?.size === 0) {
      this.timersByActor.delete(timer.owner);
      this.timerRegistrations.delete(timer.owner);
    }
  }

  private removeRegistration(timer: TimerRegistration): void {
    const registration = timer.registration;
    if (!registration) return;
    registration.remove(timer);
    if (registration.size === 0) {
      this.timerRegistrations.get(timer.owner)?.delete(timer.event);
    }
    timer.registration = undefined;
  }

  private takeRegistration(
    source: AnyActorRef,
    target: AnyActorRef,
    event: AnyEventObject,
    delay: number,
    id: string | undefined,
  ): TimerRegistration | undefined {
    // Deferred actions register in order. Search only this actor/event's
    // unregistered actions, never already pending timers or other actors.
    const registrations = this.timerRegistrations.get(source)?.get(event);
    const timer = registrations?.find(target, delay, id);
    if (timer) this.removeRegistration(timer);
    return timer;
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
    const timeoutRecords = new Map<unknown, TimerRegistration>();
    const schedule = scheduler.schedule;
    scheduler.schedule = (source, target, event, delay, id) => {
      const timer = this.takeRegistration(source, target, event, delay, id);
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
            if (timer) this.remove(timer);
            const previous = this.activeDispatch;
            this.activeDispatch = { source, target, event, timer };
            try {
              callback();
            } finally {
              this.activeDispatch = previous;
            }
          },
          delayMs,
        );
        if (timer) {
          timer.timeoutRecords = timeoutRecords;
          timer.timeoutHandle = handle;
          timeoutRecords.set(handle, timer);
        }
        return handle;
      };
      try {
        clock.setTimeout = decorateTimeout;
      } catch (error) {
        if (timer) this.remove(timer);
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
        if (timer) this.remove(timer);
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
          const timer = timeoutRecords.get(handle);
          if (timer) this.remove(timer);
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
