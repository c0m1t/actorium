import type { ActorRefLike, AnyActorRef, AnyEventObject } from 'xstate';
import type { CommandOutcome, ScheduledWorkPolicyArgs } from './types.js';

// The internal boundary between lifecycle bookkeeping and a telemetry backend.
// The runtime decides when operations and work start, fail and end; a backend
// decides how that is recorded. Not part of the public API.

/** Opaque reference that delayed work links back to. Must not retain the operation. */
export type TelemetryLink = unknown;

export type OperationStart<TCommandOptions> =
  | {
      readonly cause: 'command';
      readonly actor: AnyActorRef;
      readonly event: AnyEventObject;
      readonly options: TCommandOptions;
    }
  | {
      readonly cause: 'scheduled';
      readonly actor: AnyActorRef;
      readonly event: AnyEventObject;
      readonly name: string | undefined;
      readonly origin: TelemetryLink;
      readonly originOperationId: number;
      readonly actionType: ScheduledWorkPolicyArgs['actionType'];
      readonly delayMs: number;
    };

/** Why a target was terminal when an event was sent to it. */
export type TerminalReason = 'done' | 'error' | 'stopped';

/** Why the runtime couldn't link a command's send to counted processing. */
export type UnobservedReason = 'target_not_observed' | 'send_not_observed';

/** Set only for the `target_terminal` and `unobserved` outcomes. */
export type OutcomeReason = TerminalReason | UnobservedReason;

export interface OperationSummary {
  readonly outcome: CommandOutcome;
  readonly outcomeReason: OutcomeReason | undefined;
  readonly hadError: boolean;
  readonly errorCount: number;
  readonly terminalRecipientEvents: number;
}

export interface WorkStart<TWorkOptions> {
  readonly name: string;
  readonly input: unknown;
  readonly self: AnyActorRef;
  readonly options: TWorkOptions;
}

export interface OperationTelemetry {
  /** Called once the runtime has numbered the operation. */
  identify(id: number): void;
  ids(): { readonly traceId: string; readonly spanId: string };
  link(): TelemetryLink;
  run<T>(callback: () => T): T;
  microstep(actor: ActorRefLike, event: AnyEventObject, stateValue: () => unknown): void;
  recipientTerminal(recipient: ActorRefLike, event: AnyEventObject, reason: TerminalReason): void;
  /** Records a failure at most once; false when skipped or ended meanwhile. */
  recordFailure(error: unknown, isEnded: () => boolean): boolean;
  end(summary: OperationSummary): void;
}

export interface WorkTelemetry {
  run<T>(callback: () => T): T;
  cancelled(): void;
  /** Records a failure at most once; false when skipped or ended meanwhile. */
  recordFailure(error: unknown, isEnded: () => boolean): boolean;
  end(): void;
}

export interface TelemetryBackend<TCommandOptions, TWorkOptions> {
  /** Whether microsteps are recorded; read before resolving their operation. */
  readonly recordsMicrosteps: boolean;
  startOperation(start: OperationStart<TCommandOptions>): OperationTelemetry;
  startWork(operation: OperationTelemetry, start: WorkStart<TWorkOptions>): WorkTelemetry;
}
