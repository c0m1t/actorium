import {
  fromPromise,
  type ActorRefLike,
  type AnyActorRef,
  type AnyEventObject,
  type InspectionEvent,
  type PromiseActorLogic,
} from 'xstate';
import {
  actorParent,
  asActorRefLike,
  microstepStateValue,
  observeRootStop,
} from '../xstate/actors.js';
import { DeliveryQueue, type Delivery } from './delivery-queue.js';
import type { Diagnostics } from './diagnostics.js';
import type { ActorOperation, Continuation, Operation } from './operation.js';
import { ScheduledWork, type ScheduledDelivery } from './scheduled-work.js';
import type {
  OperationStart,
  OperationTelemetry,
  TelemetryBackend,
  WorkTelemetry,
} from './telemetry.js';
import type {
  CommandOutcome,
  CommandResult,
  CommandTrace,
  LifecycleOptions,
  PromiseActorArgs,
  ShouldTraceArgs,
} from './types.js';

interface BookkeepingGroup {
  pending: number;
  waiters: Array<() => void>;
}

/** Selection options read when a traced Promise actor starts. */
export interface WorkSelection<TInput> {
  readonly shouldTrace?: ((args: ShouldTraceArgs<TInput>) => boolean) | undefined;
}

/**
 * Backend-neutral operation lifecycle for XState v5 actor systems.
 *
 * It intentionally knows nothing about machine state names. An operation stays
 * alive while it has traced finite child actors ("continuations"). Once the
 * event/macrostep has settled and no continuations remain, the operation ends.
 * How operations and work are recorded is delegated to a TelemetryBackend.
 */
export class OperationRuntime<TCommandOptions, TWorkOptions> {
  // Groups contain accounting only, never actor/span/operation references.
  private readonly bookkeeping = new Set<BookkeepingGroup>();
  private activeBookkeeping: BookkeepingGroup | undefined;

  private readonly observedActors = new WeakSet<ActorRefLike>();
  private readonly rootActors = new WeakSet<ActorRefLike>();
  private readonly stoppedActors = new WeakSet<ActorRefLike>();
  private readonly startedActors = new WeakSet<ActorRefLike>();
  private readonly lifecycleChecks = new WeakSet<AnyActorRef>();
  private readonly terminalActors = new WeakSet<AnyActorRef>();
  private readonly scheduledWork: ScheduledWork;
  /** Commands waiting for the matching, synchronously emitted @xstate.event. */
  private readonly pendingCommands = new WeakMap<object, Operation[]>();
  private readonly actorOperations = new WeakMap<ActorRefLike, ActorOperation>();
  private readonly actorContinuations = new WeakMap<AnyActorRef, Continuation>();

  /** Every delivery is recorded, including deliveries that are not traced. */
  private readonly processing = new WeakMap<ActorRefLike, Delivery>();

  /**
   * @xstate.event is emitted before an event is put through the actor mailbox.
   * If an actor is already processing, later events can be observed before they
   * are handled. This must mirror the complete mailbox, not just traced events,
   * or an untraced delivery can accidentally inherit a later command's trace.
   */
  private readonly queued = new WeakMap<ActorRefLike, DeliveryQueue>();

  private nextOperationId = 1;

  private readonly telemetry: TelemetryBackend<TCommandOptions, TWorkOptions>;
  private readonly diagnostics: Diagnostics;
  private readonly options: LifecycleOptions;

  constructor(
    telemetry: TelemetryBackend<TCommandOptions, TWorkOptions>,
    diagnostics: Diagnostics,
    options: LifecycleOptions,
  ) {
    this.telemetry = telemetry;
    this.diagnostics = diagnostics;
    this.options = options;
    this.scheduledWork = new ScheduledWork(options.scheduledWorkPolicy, diagnostics, (actor) =>
      this.operationForActor(actor),
    );
  }

  /**
   * Wait for currently queued/executing bookkeeping and its synchronous follow-ups.
   * Does not await business work, stop actors, force span completion or export.
   */
  settle(): Promise<void> {
    const groups = [...this.bookkeeping];
    if (groups.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let remaining = groups.length;
      const completed = () => {
        if (--remaining === 0) resolve();
      };
      for (const group of groups) group.waiters.push(completed);
    });
  }

  private scheduleBookkeeping(callback: () => void): void {
    const group = this.activeBookkeeping ?? { pending: 0, waiters: [] };
    group.pending++;
    this.bookkeeping.add(group);
    queueMicrotask(() => {
      const previous = this.activeBookkeeping;
      this.activeBookkeeping = group;
      try {
        callback();
      } finally {
        this.activeBookkeeping = previous;
        if (--group.pending === 0) {
          this.bookkeeping.delete(group);
          const waiters = group.waiters;
          group.waiters = [];
          for (const completed of waiters) completed();
        }
      }
    });
  }

  readonly inspect = (inspection: InspectionEvent): void => {
    switch (inspection.type) {
      case '@xstate.actor': {
        this.observeActor(inspection.actorRef as AnyActorRef);
        // Invoked machine actors run their initial input mappers before their
        // xstate.init delivery is inspected. Capture the creating parent's
        // current operation so nested actors can join it during initialization.
        const parent = this.resolveParentActor(inspection.actorRef);
        if (!parent) this.rootActors.add(inspection.actorRef);
        const operation = parent ? this.operationForActor(parent) : undefined;
        if (operation && !operation.ended) {
          this.setActorOperation(inspection.actorRef, operation, parent as AnyActorRef);
        }
        return;
      }

      case '@xstate.event': {
        // A child's terminal snapshot is final before its parent receives the
        // relay. Reconcile here to retain ownership through onDone/onError.
        if (inspection.sourceRef) {
          this.reconcileActorLifecycle(inspection.sourceRef as AnyActorRef);
        }
        const dispatch = this.scheduledWork.claimDispatch(
          inspection.sourceRef,
          inspection.actorRef,
          inspection.event,
        );
        // A source system also inspects relays to foreign actor systems. Only
        // count recipients whose snapshots this runtime can actually observe.
        if (!this.observedActors.has(inspection.actorRef)) {
          return;
        }
        if (inspection.event.type === 'xstate.init') {
          this.startedActors.add(inspection.actorRef);
        }
        this.deferLifecycleCheck(inspection.actorRef as AnyActorRef);
        // Native initialization still runs for restored/initial error or done
        // snapshots. It is not a discarded send to an already stopped actor.
        if (
          inspection.event.type !== 'xstate.init' &&
          this.isStopped(inspection.actorRef as AnyActorRef)
        ) {
          // XState refuses the relay at send time. Nothing was accepted for the
          // operation, so record the drop without changing its outcome.
          const operation = this.operationForIncomingEvent(inspection.event, inspection.sourceRef);
          if (operation && !operation.ended) {
            operation.droppedDeliveries++;
            operation.telemetry.droppedDelivery(inspection.actorRef, inspection.event);
          }
          return;
        }
        // An explicit command always owns its delivery. Only a clock callback
        // registered by the public scheduler can claim a scheduling record.
        const directlyAssociated = this.shiftPendingCommand(inspection.event, inspection.actorRef);
        const scheduled = dispatch?.scheduled;
        const operation =
          directlyAssociated ??
          (dispatch
            ? scheduled
              ? this.operationForScheduledDelivery(
                  inspection.actorRef as AnyActorRef,
                  inspection.event,
                  scheduled,
                )
              : undefined
            : inspection.event.type === 'xstate.init'
              ? this.actorOperations.get(inspection.actorRef)?.operation
              : this.operationForIncomingEvent(inspection.event, inspection.sourceRef));
        if (scheduled) {
          this.scheduledWork.remove(scheduled);
        }

        if (operation?.ended) {
          this.enqueueDelivery(inspection.actorRef, inspection.event, undefined);
          return;
        }

        if (operation) {
          operation.deliveryObserved = true;
          operation.pendingDeliveries += 1;
        }

        this.enqueueDelivery(inspection.actorRef, inspection.event, operation);
        return;
      }

      case '@xstate.action': {
        // A child stopped before start emits neither completion nor snapshot.
        // Running children still process deferred exit sends before stopping.
        if (inspection.action.type === 'xstate.stopChild') {
          const child = asActorRefLike(inspection.action.params);
          if (child && !this.startedActors.has(child)) {
            this.stopObservedActor(child as AnyActorRef);
          }
        }
        this.scheduledWork.observeAction(
          inspection.actorRef as AnyActorRef,
          inspection.action.type,
          inspection.action.params,
        );
        return;
      }

      case '@xstate.microstep': {
        if (!this.telemetry.recordsMicrosteps) {
          return;
        }

        const operation = this.operationForMicrostep(inspection.actorRef, inspection.event);
        if (!operation || operation.ended) {
          return;
        }
        operation.telemetry.microstep(inspection.actorRef, inspection.event, () =>
          microstepStateValue(inspection),
        );
        return;
      }

      case '@xstate.snapshot': {
        const actorRef = inspection.actorRef as AnyActorRef;
        // Deferred startup effects can fail after the notification's snapshot
        // was captured. Read the actor's current public snapshot instead.
        this.reconcileActorLifecycle(actorRef, inspection.event.type === 'xstate.stop');
        const delivery = this.finishDelivery(inspection.actorRef, inspection.event);
        const operation = delivery?.operation;

        // A snapshot closes one delivered event / one actor processing turn.
        if (operation && !operation.ended) {
          operation.pendingDeliveries = Math.max(0, operation.pendingDeliveries - 1);

          this.maybeEndOperation(operation);
        }

        // A terminal actor will never consume anything left in its mailbox.
        if (inspection.snapshot.status !== 'active' || inspection.event.type === 'xstate.stop') {
          this.stoppedActors.add(actorRef);
          this.cancelQueuedDeliveries(inspection.actorRef);
          this.scheduledWork.cancel(inspection.actorRef as AnyActorRef);
        }

        if (inspection.event.type === 'xstate.init') {
          this.clearActorOperation(inspection.actorRef);
        }

        // A finite traced child remains a continuation until XState itself says
        // the actor is terminal. This is deliberately later than Promise.resolve:
        // by then XState has relayed onDone/onError to the parent, allowing the
        // parent macrostep to start a replacement continuation first.
        const continuation = this.actorContinuations.get(actorRef);
        if (continuation && inspection.snapshot.status !== 'active') {
          this.releaseContinuation(actorRef, inspection.snapshot.status, inspection.snapshot.error);
        }
        return;
      }

      default:
        return;
    }
  };

  sendCommand(actor: AnyActorRef, event: AnyEventObject, options: TCommandOptions): CommandTrace {
    const operation = this.startOperation(actor, event, {
      cause: 'command',
      actor,
      event,
      options,
    });
    const commandTrace = this.commandTrace(operation);

    if (this.isStopped(actor)) {
      this.finishOperation(operation, 'dropped');
      return commandTrace;
    }

    this.pushPendingCommand(event, operation);

    try {
      actor.send(event);
    } catch (error) {
      this.removePendingCommand(event, operation);
      this.rollbackCommandDeliveries(actor, operation);
      this.failOperation(operation, error);
      throw error;
    }

    this.removePendingCommand(event, operation);

    // Sending to a stopped actor is a no-op in XState. Do not leak an open span
    // when no @xstate.event was emitted for the command.
    if (!operation.deliveryObserved) {
      this.finishOperation(operation, 'dropped');
    }

    return commandTrace;
  }

  withActiveOperation<T>(actor: AnyActorRef, callback: () => T): T {
    const operation = this.operationForActor(actor);
    return operation && !operation.ended ? operation.telemetry.run(callback) : callback();
  }

  fromPromise<TOutput, TInput, TEmitted extends AnyEventObject>(
    name: string,
    implementation: (args: PromiseActorArgs<TInput, TEmitted>) => Promise<TOutput>,
    options: TWorkOptions & WorkSelection<TInput>,
  ): PromiseActorLogic<TOutput, TInput, TEmitted> {
    return fromPromise<TOutput, TInput, TEmitted>(async ({ input, signal, self, system, emit }) => {
      // Ownership belongs to this actor, captured before initialization.
      // A later command on the parent cannot claim this child's work.
      const association = this.actorOperations.get(self);
      const operation = association?.operation;
      const selected =
        operation &&
        !operation.ended &&
        this.diagnostics.protect(
          'shouldTrace',
          () => {
            const shouldTrace = options.shouldTrace;
            const decision =
              shouldTrace === undefined
                ? true
                : shouldTrace({
                    name,
                    input,
                    self: self as AnyActorRef,
                    parent: association?.parent,
                  });
            if (typeof decision !== 'boolean') {
              throw new TypeError('fromPromise shouldTrace must return a boolean');
            }
            return decision;
          },
          true,
        );

      // This invoke did not originate from a traced command. Keep the helper
      // usable for startup/background flows without manufacturing a trace.
      if (!selected || !operation || operation.ended) {
        return implementation({
          input,
          signal,
          self: self as AnyActorRef,
          system,
          emit,
        });
      }

      const actorRef = self as AnyActorRef;
      const work = this.telemetry.startWork(operation.telemetry, {
        name,
        input,
        self: actorRef,
        options,
      });
      const continuation = this.registerContinuation(actorRef, operation, work);

      try {
        return await work.run(() =>
          implementation({
            input,
            signal,
            self: actorRef,
            system,
            emit,
          }),
        );
      } catch (error) {
        // The XState stop snapshot can arrive before the underlying aborted
        // Promise rejects. Never mutate a span after the inspector ended it.
        if (!continuation.spanEnded) {
          if (signal.aborted && isAbortError(error)) {
            work.cancelled();
          } else {
            operation.hadError = true;
            this.recordFailure(operation, work, error, () => continuation.spanEnded);
          }
        }
        throw error;
      } finally {
        // End the work span when the Promise work itself ends, but DO NOT
        // release the continuation here. XState still needs to process the
        // resulting onDone/onError event. The inspector releases it when the
        // child actor reaches its terminal snapshot.
        this.endContinuationSpan(actorRef);
      }
    });
  }

  private startOperation(
    actor: AnyActorRef,
    event: AnyEventObject,
    start: OperationStart<TCommandOptions>,
  ): Operation {
    const telemetry = this.telemetry.startOperation(start);

    let resolveFinished!: (result: CommandResult) => void;
    const finished = new Promise<CommandResult>((resolve) => {
      resolveFinished = resolve;
    });

    const operation: Operation = {
      id: this.nextOperationId++,
      rootActor: actor,
      telemetry,
      continuations: new Set(),
      associatedActors: new Set(),
      pendingDeliveries: 0,
      endScheduled: false,
      ended: false,
      cancelled: false,
      hadError: false,
      errorCount: 0,
      droppedDeliveries: 0,
      rootFailed: false,
      deliveryObserved: false,
      finished,
      resolveFinished,
    };

    telemetry.identify(operation.id);
    return operation;
  }

  private operationForIncomingEvent(
    event: AnyEventObject,
    sourceRef: unknown,
  ): Operation | undefined {
    if (sourceRef && typeof sourceRef === 'object') {
      const source = sourceRef as AnyActorRef;

      // onDone/onError from a traced finite child.
      const childOperation = this.actorContinuations.get(source)?.operation;
      if (childOperation) {
        return childOperation;
      }

      // Actor-to-actor event emitted while the source actor is itself handling
      // a traced operation.
      const sourceProcessing = this.operationForActor(source);
      if (sourceProcessing) {
        return sourceProcessing;
      }
    }

    return undefined;
  }

  private operationForScheduledDelivery(
    actor: AnyActorRef,
    event: AnyEventObject,
    scheduled: ScheduledDelivery,
  ): Operation | undefined {
    if (scheduled.policy.mode === 'untraced') {
      return undefined;
    }

    return this.startOperation(actor, event, {
      cause: 'scheduled',
      actor,
      event,
      name: scheduled.policy.name,
      origin: scheduled.origin,
      originOperationId: scheduled.originOperationId,
      actionType: scheduled.actionType,
      delayMs: scheduled.delayMs,
    });
  }

  private operationForActor(actor: ActorRefLike): Operation | undefined {
    // Before init, mailbox entries have not run. Only ownership captured from
    // the creating parent may apply to nested input mappers/initialization.
    if (!this.startedActors.has(actor)) {
      return this.actorOperations.get(actor)?.operation;
    }
    const delivery = this.processing.get(actor);
    return delivery ? delivery.operation : this.actorOperations.get(actor)?.operation;
  }

  private enqueueDelivery(
    actor: ActorRefLike,
    event: AnyEventObject,
    operation: Operation | undefined,
  ): void {
    const item: Delivery = { event, operation, previous: undefined, next: undefined };

    const current = this.processing.get(actor);
    if (!current) {
      this.processing.set(actor, item);
      return;
    }

    const queue = this.queued.get(actor) ?? new DeliveryQueue();
    if (event.type === 'xstate.init') {
      // XState runs init ahead of events accepted before start(). Make the
      // actual init turn active, then restore the original mailbox head when
      // its snapshot settles. Queued commands cannot own startup work.
      queue.prepend(current);
      this.processing.set(actor, item);
    } else {
      queue.append(item);
    }
    this.queued.set(actor, queue);
  }

  private finishDelivery(actor: ActorRefLike, event: AnyEventObject): Delivery | undefined {
    const current = this.processing.get(actor);

    if (current?.event !== event) {
      // Reconcile an out-of-order snapshot by exact event identity without
      // advancing an unrelated mailbox head.
      const queue = this.queued.get(actor);
      const matched = queue?.removeFirst(event);
      if (queue?.length === 0) {
        this.queued.delete(actor);
      }
      return matched;
    }

    const queue = this.queued.get(actor);
    const next = queue?.takeFirst();

    if (queue && queue.length === 0) {
      this.queued.delete(actor);
    }

    if (next) {
      this.processing.set(actor, next);
    } else {
      this.processing.delete(actor);
    }

    return current;
  }

  private rollbackCommandDeliveries(actor: ActorRefLike, operation: Operation): void {
    // Inspection precedes mailbox acceptance. A later inspector can throw
    // after we recorded the command, leaving no snapshot to consume it. Remove
    // only this operation's records, preserving every other mailbox entry.
    const queue = this.queued.get(actor);
    let removed = queue?.removeOperation(operation) ?? 0;

    if (this.processing.get(actor)?.operation === operation) {
      removed += 1;
      const next = queue?.takeFirst();
      if (next) {
        this.processing.set(actor, next);
      } else {
        this.processing.delete(actor);
      }
    }

    if (queue?.length === 0) {
      this.queued.delete(actor);
    }
    operation.pendingDeliveries = Math.max(0, operation.pendingDeliveries - removed);
  }

  private operationForMicrostep(actor: ActorRefLike, event: AnyEventObject): Operation | undefined {
    const current = this.processing.get(actor);
    if (!current) {
      return undefined;
    }
    if (current.event === event) {
      return current.operation;
    }

    // Raised/internal events produce microsteps inside the current macrostep
    // without producing their own @xstate.event delivery. Attribute those to
    // the macrostep. xstate.init is the exception: for a pre-start queued event,
    // its initial microstep can occur before the init delivery is inspected.
    if (event.type === 'xstate.init') {
      return undefined;
    }

    // Raised/internal events belong to this macrostep even if their event
    // object is also waiting in another mailbox entry.
    return current.operation;
  }

  private cancelQueuedDeliveries(actor: ActorRefLike): void {
    const current = this.processing.get(actor);
    const queue = this.queued.get(actor);
    this.queued.delete(actor);
    this.processing.delete(actor);

    for (let delivery = current ?? queue?.takeFirst(); delivery; delivery = queue?.takeFirst()) {
      const operation = delivery.operation;
      if (!operation || operation.ended) {
        continue;
      }
      operation.pendingDeliveries = Math.max(0, operation.pendingDeliveries - 1);
      operation.cancelled = true;
      this.maybeEndOperation(operation);
    }
  }

  private deferLifecycleCheck(actor: AnyActorRef): void {
    if (this.lifecycleChecks.has(actor) || this.terminalActors.has(actor)) return;
    this.lifecycleChecks.add(actor);
    // Error paths can omit snapshot inspection. One public snapshot check per
    // actor/turn observes them without subscribing to (and consuming) errors.
    this.scheduleBookkeeping(() => {
      this.lifecycleChecks.delete(actor);
      this.reconcileActorLifecycle(actor);
    });
  }

  private reconcileActorLifecycle(actor: AnyActorRef, stopped = false): void {
    if (!this.observedActors.has(actor) || this.terminalActors.has(actor)) return;
    const snapshot = actor.getSnapshot();
    if (snapshot.status === 'error') {
      // Construction/restoration can produce an error before start(). XState
      // reports it only at startup; queued pre-start sends must not report it.
      if (!this.startedActors.has(actor)) return;
      this.terminalActors.add(actor);
      this.handleActorError(actor, snapshot.error);
    } else if (stopped || snapshot.status === 'done' || snapshot.status === 'stopped') {
      this.terminalActors.add(actor);
      this.stoppedActors.add(actor);
      // Keep ownership through the synchronous parent relay and final snapshot.
      this.scheduleBookkeeping(() => this.stopObservedActor(actor));
    }
  }

  private observeActor(actor: AnyActorRef): void {
    if (this.observedActors.has(actor)) {
      return;
    }
    if (this.scheduledWork.enabled) {
      // Invalid integration is a setup error, before business initialization.
      // Do not turn it into an unmarked native timer fallback.
      try {
        this.scheduledWork.instrument(actor);
      } catch (error) {
        this.diagnostics.report({ phase: 'scheduler', error });
        throw error;
      }
    }
    this.observedActors.add(actor);
    // XState rejects public stop() on child actors and stops them internally,
    // so only roots need the stop boundary.
    if (!actorParent(actor)) {
      observeRootStop(actor, (stopped) => {
        if (this.observedActors.has(stopped as AnyActorRef)) {
          this.stopObservedActor(stopped as AnyActorRef);
        }
      });
    }
  }

  private setActorOperation(actor: ActorRefLike, operation: Operation, parent?: AnyActorRef): void {
    this.clearActorOperation(actor);
    this.actorOperations.set(actor, { operation, parent });
    operation.associatedActors.add(actor);
  }

  private clearActorOperation(actor: ActorRefLike): void {
    this.actorOperations.get(actor)?.operation.associatedActors.delete(actor);
    this.actorOperations.delete(actor);
  }

  private isStopped(actor: AnyActorRef): boolean {
    return this.stoppedActors.has(actor) || actor.getSnapshot().status !== 'active';
  }

  private stopObservedActor(actor: AnyActorRef): void {
    if (this.startedActors.has(actor) && actor.getSnapshot().status === 'error') {
      // A stop immediately after failure must not classify pending work as
      // cancellation before the deferred failure check has reconciled it.
      this.reconcileActorLifecycle(actor);
      return;
    }
    this.terminalActors.add(actor);
    this.stoppedActors.add(actor);
    this.cancelQueuedDeliveries(actor);
    this.scheduledWork.cancel(actor);
    this.clearActorOperation(actor);
    this.releaseContinuation(actor, 'stopped');
  }

  private handleActorError(actor: AnyActorRef, error: unknown): void {
    const current = this.processing.get(actor);
    this.processing.delete(actor);

    const operation =
      current?.operation ??
      this.actorOperations.get(actor)?.operation ??
      this.actorContinuations.get(actor)?.operation;
    const rootErrorPhase = this.rootActors.has(actor)
      ? operation && !operation.ended
        ? 'associatedRootError'
        : 'unassociatedRootError'
      : undefined;
    if (operation && !operation.ended) {
      operation.hadError = true;
      if (operation.rootActor === actor) {
        operation.rootFailed = true;
        this.recordFailure(operation, operation.telemetry, error, () => operation.ended);
      }
      if (current?.operation === operation) {
        operation.pendingDeliveries = Math.max(0, operation.pendingDeliveries - 1);
      }
      this.maybeEndOperation(operation);
      // The parent's onError relay occurs after error observers, and can start
      // replacement finite work. Preserve ownership through that synchronous
      // relay even when XState omits the failed child's inspection snapshot.
      this.setActorOperation(actor, operation);
    }

    // XState clears its mailbox when an actor errors. Close our mirrored
    // deliveries and schedules too, marking later queued commands as
    // cancelled.
    this.cancelQueuedDeliveries(actor);
    this.scheduledWork.cancel(actor);
    this.stoppedActors.add(actor);
    this.scheduleBookkeeping(() => {
      this.clearActorOperation(actor);
      this.releaseContinuation(actor, 'error', error);
    });
    if (rootErrorPhase) {
      this.diagnostics.report({ phase: rootErrorPhase, error });
    }
  }

  private pushPendingCommand(event: AnyEventObject, operation: Operation): void {
    const pending = this.pendingCommands.get(event) ?? [];
    pending.push(operation);
    this.pendingCommands.set(event, pending);
  }

  private shiftPendingCommand(
    event: AnyEventObject,
    recipient: ActorRefLike,
  ): Operation | undefined {
    const pending = this.pendingCommands.get(event);
    const index = pending?.findIndex((operation) => operation.rootActor === recipient) ?? -1;
    const operation = index === -1 ? undefined : pending?.splice(index, 1)[0];
    if (pending?.length === 0) {
      this.pendingCommands.delete(event);
    }
    return operation;
  }

  private removePendingCommand(event: AnyEventObject, operation: Operation): void {
    const pending = this.pendingCommands.get(event);
    if (!pending) {
      return;
    }
    const index = pending.indexOf(operation);
    if (index !== -1) {
      pending.splice(index, 1);
    }
    if (pending.length === 0) {
      this.pendingCommands.delete(event);
    }
  }

  private registerContinuation(
    actor: AnyActorRef,
    operation: Operation,
    telemetry: WorkTelemetry,
  ): Continuation {
    const continuation: Continuation = {
      operation,
      telemetry,
      spanEnded: false,
    };

    operation.continuations.add(actor);
    this.actorContinuations.set(actor, continuation);
    return continuation;
  }

  private endContinuationSpan(actor: AnyActorRef): void {
    const continuation = this.actorContinuations.get(actor);
    if (!continuation || continuation.spanEnded) {
      return;
    }

    continuation.spanEnded = true;
    continuation.telemetry.end();
  }

  private releaseContinuation(actor: AnyActorRef, status: string, error?: unknown): void {
    const continuation = this.actorContinuations.get(actor);
    if (!continuation) {
      return;
    }

    const { operation, telemetry } = continuation;

    if (!continuation.spanEnded) {
      if (status === 'stopped') {
        telemetry.cancelled();
      } else if (status === 'error') {
        this.recordFailure(operation, telemetry, error, () => continuation.spanEnded);
      }
      if (!continuation.spanEnded) {
        continuation.spanEnded = true;
        telemetry.end();
      }
    }

    if (status === 'stopped') {
      operation.cancelled = true;
    }
    if (status === 'error') {
      operation.hadError = true;
    }

    operation.continuations.delete(actor);
    this.actorContinuations.delete(actor);
    this.maybeEndOperation(operation);
  }

  private maybeEndOperation(operation: Operation): void {
    if (operation.ended || operation.endScheduled) {
      return;
    }

    // Do not end synchronously at the first observed zero. XState may be in the
    // middle of handing a child completion back to its parent, which can start
    // the next finite invoke in the same turn. Rechecking in a microtask makes
    // the continuation hand-off robust without knowing any state names.
    operation.endScheduled = true;

    this.scheduleBookkeeping(() => {
      operation.endScheduled = false;

      if (
        operation.ended ||
        operation.pendingDeliveries !== 0 ||
        operation.continuations.size !== 0
      ) {
        return;
      }

      const outcome = operation.rootFailed
        ? 'failed'
        : operation.cancelled
          ? 'cancelled'
          : 'completed';

      this.finishOperation(operation, outcome);
    });
  }

  // Callers own the operation/continuation end guard; the backend deduplicates
  // per record, since Promise rejection and actor reconciliation can observe
  // one failure.
  private recordFailure(
    operation: Operation,
    telemetry: OperationTelemetry | WorkTelemetry,
    error: unknown,
    isEnded: () => boolean,
  ): void {
    if (telemetry.recordFailure(error, isEnded)) operation.errorCount++;
  }

  private failOperation(operation: Operation, error: unknown): void {
    if (operation.ended) {
      return;
    }

    operation.hadError = true;
    this.recordFailure(operation, operation.telemetry, error, () => operation.ended);
    this.finishOperation(operation, 'failed');
  }

  private finishOperation(operation: Operation, outcome: CommandOutcome): void {
    if (operation.ended) {
      return;
    }

    operation.ended = true;
    for (const actor of operation.associatedActors) {
      this.clearActorOperation(actor);
    }
    operation.telemetry.end({
      outcome,
      hadError: operation.hadError,
      errorCount: operation.errorCount,
      droppedDeliveries: operation.droppedDeliveries,
    });
    operation.resolveFinished({ outcome, hadError: operation.hadError });
  }

  private commandTrace(operation: Operation): CommandTrace {
    const { traceId, spanId } = operation.telemetry.ids();
    return {
      operationId: operation.id,
      traceId,
      spanId,
      finished: operation.finished,
    };
  }

  private resolveParentActor(actor: ActorRefLike): ActorRefLike | undefined {
    return this.diagnostics.protect(
      'resolveParentActor',
      () =>
        this.options.resolveParentActor
          ? this.options.resolveParentActor(actor)
          : actorParent(actor),
      actorParent(actor),
    );
  }
}

function isAbortError(error: unknown): boolean {
  try {
    return (
      error instanceof Error && (error.name === 'AbortError' || error.message === 'AbortError')
    );
  } catch {
    return false;
  }
}
