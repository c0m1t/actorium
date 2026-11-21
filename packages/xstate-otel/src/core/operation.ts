import type { ActorRefLike, AnyActorRef } from 'xstate';
import type { OperationTelemetry, WorkTelemetry } from './telemetry.js';
import type { OperationResult } from './types.js';

export interface Operation {
  readonly id: number;
  readonly targetActor: AnyActorRef;
  readonly telemetry: OperationTelemetry;
  readonly workRegistrations: Set<AnyActorRef>;
  readonly associatedActors: Set<ActorRefLike>;
  pendingEventCount: number;
  endScheduled: boolean;
  ended: boolean;
  cancelled: boolean;
  hadError: boolean;
  /** Failed work/operation records, counted once each. */
  errorCount: number;
  /** Relays whose observed recipient was already terminal when they were sent. */
  terminalRecipientEvents: number;
  targetFailed: boolean;
  readonly finished: Promise<OperationResult>;
  readonly resolveFinished: (result: OperationResult) => void;
}

/** Finite traced work that keeps its operation open. */
export interface WorkRegistration {
  readonly operation: Operation;
  readonly telemetry: WorkTelemetry;
  spanEnded: boolean;
}

export interface ActorOperation {
  readonly operation: Operation;
  readonly parent: AnyActorRef | undefined;
}
