import { diag, type Tracer } from '@opentelemetry/api';
import type { AnyActorRef, AnyEventObject, InspectionEvent, PromiseActorLogic } from 'xstate';
import { Diagnostics } from '../core/diagnostics.js';
import { OperationRuntime } from '../core/runtime.js';
import type { CommandEvent, CommandTrace, PromiseActorArgs } from '../core/types.js';
import type {
  CreateXStateTracingOptions,
  FromPromiseOptions,
  SendCommandOptions,
  TracedWorkOptions,
  XStateTracingOptions,
} from '../types.js';
import { OtelTelemetry } from './telemetry.js';

export function createXStateTracing(options: CreateXStateTracingOptions): XStateTracing {
  const { tracer, ...tracingOptions } = options;
  return new XStateTracing(tracer, tracingOptions);
}

/**
 * OpenTelemetry tracing for XState v5 actor systems.
 *
 * It intentionally knows nothing about machine state names. An operation stays
 * alive while it has traced finite child actors ("continuations"). Once the
 * event/macrostep has settled and no continuations remain, the operation ends.
 */
export class XStateTracing {
  private readonly runtime: OperationRuntime<SendCommandOptions, TracedWorkOptions>;

  /** Pass this directly to createActor(machine, { inspect: tracing.inspect }). */
  readonly inspect: (inspection: InspectionEvent) => void;

  constructor(tracer: Tracer, options: XStateTracingOptions = {}) {
    const diagnostics = new Diagnostics(options, (diagnostic) =>
      diag.warn('XState tracing telemetry callback failed', diagnostic.phase, diagnostic.error),
    );
    this.runtime = new OperationRuntime(
      new OtelTelemetry(tracer, options, diagnostics),
      diagnostics,
      options,
    );
    this.inspect = this.runtime.inspect;
  }

  /**
   * Wait for currently queued/executing bookkeeping and its synchronous follow-ups.
   * Does not await business work, stop actors, force span completion or export.
   */
  settle(): Promise<void> {
    return this.runtime.settle();
  }

  /**
   * Sends an externally-originated command and creates its semantic operation
   * span. No trace/span IDs are added to the business event.
   */
  sendCommand<TActor extends AnyActorRef>(
    actor: TActor,
    event: CommandEvent<TActor>,
    options: SendCommandOptions,
  ): CommandTrace;
  // The typed overload is a compile-time constraint only.
  sendCommand(
    actor: AnyActorRef,
    event: AnyEventObject,
    options: SendCommandOptions,
  ): CommandTrace {
    return this.runtime.sendCommand(actor, event, options);
  }

  /**
   * Runs a callback with the current command span active when `actor` is
   * processing traced work. Useful for explicitly instrumented synchronous
   * actions; prefer invoked actors for asynchronous work.
   */
  withActiveOperation<T>(actor: AnyActorRef, callback: () => T): T {
    return this.runtime.withActiveOperation(actor, callback);
  }

  /**
   * Wrap finite Promise actor logic. The returned actor creates one child span
   * and continues the operation captured from its parent at actor creation.
   * shouldTrace can exclude individual children without changing business input.
   * Auto-instrumented fetch/HTTP calls inside `implementation` become children
   * of this span because its OTel context is made active.
   */
  fromPromise<TOutput, TInput = unknown, TEmitted extends AnyEventObject = AnyEventObject>(
    name: string,
    implementation: (args: PromiseActorArgs<TInput, TEmitted>) => Promise<TOutput>,
    options: FromPromiseOptions<TInput> = {},
  ): PromiseActorLogic<TOutput, TInput, TEmitted> {
    return this.runtime.fromPromise(name, implementation, options);
  }
}
