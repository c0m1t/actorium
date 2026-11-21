import type { ActorRefLike, AnyActorRef } from 'xstate';
import type { OperationTelemetry, WorkTelemetry } from './telemetry.js';
import type { CommandResult } from './types.js';

export interface Operation {
  readonly id: number;
  readonly rootActor: AnyActorRef;
  readonly telemetry: OperationTelemetry;
  readonly continuations: Set<AnyActorRef>;
  readonly associatedActors: Set<ActorRefLike>;
  pendingDeliveries: number;
  endScheduled: boolean;
  ended: boolean;
  cancelled: boolean;
  hadError: boolean;
  /** Failed work/operation records, counted once each. */
  errorCount: number;
  /** Relays whose observed recipient was already terminal when they were sent. */
  terminalRecipientEvents: number;
  rootFailed: boolean;
  readonly finished: Promise<CommandResult>;
  readonly resolveFinished: (result: CommandResult) => void;
}

/** Finite traced work that keeps its operation open. */
export interface Continuation {
  readonly operation: Operation;
  readonly telemetry: WorkTelemetry;
  spanEnded: boolean;
}

export interface ActorOperation {
  readonly operation: Operation;
  readonly parent: AnyActorRef | undefined;
}
