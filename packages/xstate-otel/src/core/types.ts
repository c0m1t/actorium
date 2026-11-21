import type { ActorRef, ActorRefLike, AnyActorRef, AnyEventObject } from 'xstate';

// Public types that do not depend on a telemetry backend.

export type ScheduledWorkPolicy =
  | { mode: 'untraced' }
  | { mode: 'new-linked-operation'; name?: string };

export interface ScheduledWorkPolicyArgs {
  actor: AnyActorRef;
  actionType: 'xstate.raise' | 'xstate.sendTo';
  event: AnyEventObject;
  delayMs: number;
  id?: string;
}

export interface PromiseActorArgs<TInput, TEmitted extends AnyEventObject = AnyEventObject> {
  input: TInput;
  signal: AbortSignal;
  self: AnyActorRef;
  system: AnyActorRef['system'];
  emit: (event: TEmitted) => void;
}

export interface ShouldTraceArgs<TInput> {
  readonly name: string;
  readonly input: TInput;
  readonly self: AnyActorRef;
  readonly parent: AnyActorRef | undefined;
}

export interface TelemetryDiagnostic {
  readonly phase:
    | 'errorDetails'
    | 'operationAttributes'
    | 'workAttributes'
    | 'shouldTrace'
    | 'scheduledWorkPolicy'
    | 'resolveParentActor'
    | 'scheduler'
    | 'unassociatedRootError'
    | 'associatedRootError';
  readonly error: unknown;
}

/** Options read by the lifecycle runtime. Telemetry presentation options live with the backend. */
export interface LifecycleOptions {
  /** Optional protected diagnostics; root reports may follow send/start in a microtask. */
  onTelemetryError?: (diagnostic: TelemetryDiagnostic) => void;
  /**
   * Opts into native timer integration for delayed XState `raise` and `sendTo`
   * actions, including `after`. Unset installs no scheduler hooks. Decisions
   * are validated and copied per action; timers never hold an operation open.
   * Unsupported clock/scheduler delegation throws during actor creation.
   */
  scheduledWorkPolicy?:
    | ScheduledWorkPolicy
    | ((args: ScheduledWorkPolicyArgs) => ScheduledWorkPolicy);
  resolveParentActor?: (actor: ActorRefLike) => ActorRefLike | undefined;
}

/**
 * Events accepted by a command target. Typed actors constrain commands to
 * their own event union; untyped targets (`AnyActorRef`, whose event parameter
 * is `any`) still require an `AnyEventObject`. Type-only: no runtime
 * validation is added.
 */
export type CommandEvent<TActor extends AnyActorRef> =
  TActor extends ActorRef<any, infer TEvent, any>
    ? 0 extends 1 & TEvent
      ? AnyEventObject
      : TEvent
    : AnyEventObject;

/** See the outcomes reference for definitions, reasons and precedence. */
export type CommandOutcome =
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'target_terminal'
  | 'unobserved';

export interface CommandResult {
  readonly outcome: CommandOutcome;
  readonly hadError: boolean;
}

export interface CommandTrace {
  readonly operationId: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly finished: Promise<CommandResult>;
}
