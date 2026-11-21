import type { Attributes, Context, Link, SpanKind, Tracer } from '@opentelemetry/api';
import type { AnyActorRef, AnyEventObject } from 'xstate';
import type { LifecycleOptions, ShouldTraceArgs } from './core/types.js';

export type {
  CommandEvent,
  OperationOutcome,
  OperationResult,
  OperationTrace,
  PromiseActorArgs,
  ShouldTraceArgs,
  TelemetryDiagnostic,
  TimerPolicy,
  TimerPolicyArgs,
} from './core/types.js';

/** The part of FromPromiseOptions read by the telemetry backend. */
export interface TracedWorkOptions {
  attributes?: Attributes;
}

export interface FromPromiseOptions<TInput> extends TracedWorkOptions {
  /** Evaluated once at startup with a live creating operation; defaults to true. */
  shouldTrace?: (args: ShouldTraceArgs<TInput>) => boolean;
}

export interface SendCommandOptions {
  /** Semantic span name, e.g. `checkout.add_item`. */
  name: string;
  attributes?: Attributes;

  /**
   * `link` is the default for a fire-and-forget route action: the XState
   * operation becomes a new trace linked to the incoming HTTP span.
   *
   * Use `child` when the route/request actually waits for the XState
   * operation to finish and you want one parent/child trace.
   */
  relationship?: 'link' | 'child';
  parentContext?: Context;
  kind?: SpanKind;
  links?: Link[];
}

export interface ErrorDetails {
  type?: string;
  message?: string;
  stack?: string;
  /** Additional exception-event attributes; dedicated fields take precedence. */
  attributes?: Attributes;
}

export interface XStateTracingOptions extends LifecycleOptions {
  /**
   * Prefix for every attribute, span-event and span name this package emits;
   * default `actorium.xstate`. Use lowercase, dot-separated snake_case
   * segments; anything else throws at construction. `actorIdAttribute` and
   * `detailsUnavailableAttribute` still replace their full key.
   */
  telemetryNamespace?: string;
  /** Synchronous replacement for default failure details; {} suppresses details. */
  errorDetails?: (error: unknown) => ErrorDetails;
  /** Attribute for unavailable error details; false disables it. */
  detailsUnavailableAttribute?: string | false;
  recordMicrosteps?: boolean;
  recordStateValues?: boolean;
  actorIdAttribute?: string | false;
  operationSpanKind?: SpanKind;
  workSpanKind?: SpanKind;
  commonAttributes?: Attributes;
  operationAttributes?: (args: { actor: AnyActorRef; event: AnyEventObject }) => Attributes;
  workAttributes?: (args: { name: string; input: unknown; self: AnyActorRef }) => Attributes;
}

export interface CreateXStateTracingOptions extends XStateTracingOptions {
  tracer: Tracer;
}
