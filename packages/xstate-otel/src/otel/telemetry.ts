import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api';
import type { ActorRefLike, AnyActorRef, AnyEventObject } from 'xstate';
import type { Diagnostics } from '../core/diagnostics.js';
import type {
  OperationStart,
  OperationSummary,
  OperationTelemetry,
  TelemetryBackend,
  TerminalReason,
  WorkStart,
  WorkTelemetry,
} from '../core/telemetry.js';
import type { SendCommandOptions, TracedWorkOptions, XStateTracingOptions } from '../types.js';
import { actorId } from '../xstate/actors.js';
import { getAttributeKeys, type AttributeKeys } from './attributes.js';

interface FailureDetails {
  type?: string | undefined;
  attributes?: Attributes | undefined;
  message?: string | undefined;
  stack?: string | undefined;
  detailsUnavailable: boolean;
}

/** Records operations as spans and finite work as child spans. */
export class OtelTelemetry implements TelemetryBackend<SendCommandOptions, TracedWorkOptions> {
  private readonly failedSpans = new WeakSet<Span>();
  /** Emitted names, resolved and validated once at construction. */
  readonly keys: AttributeKeys;

  private readonly tracer: Tracer;
  private readonly options: XStateTracingOptions;
  private readonly diagnostics: Diagnostics;

  constructor(tracer: Tracer, options: XStateTracingOptions, diagnostics: Diagnostics) {
    this.tracer = tracer;
    this.options = options;
    this.diagnostics = diagnostics;
    this.keys = getAttributeKeys(options.attributeNamespace);
  }

  get recordsMicrosteps(): boolean {
    return Boolean(this.options.recordMicrosteps);
  }

  startOperation(start: OperationStart<SendCommandOptions>): OperationTelemetry {
    if (start.cause === 'command') {
      return this.startCommand(start.actor, start.event, start.options);
    }
    const parentContext = trace.setSpanContext(ROOT_CONTEXT, start.origin as SpanContext);
    return this.startCommand(start.actor, start.event, {
      name: start.name ?? this.keys.scheduledSpan,
      relationship: 'link',
      parentContext,
      attributes: {
        [this.keys.scheduledAction]: start.actionType,
        [this.keys.scheduledDelayMs]: start.delayMs,
        [this.keys.scheduledOriginOperationId]: start.originOperationId,
      },
    });
  }

  private startCommand(
    actor: AnyActorRef,
    event: AnyEventObject,
    options: SendCommandOptions,
  ): OperationSpan {
    const parentContext = options.parentContext ?? context.active();
    const relationship = options.relationship ?? 'link';
    const parentSpanContext = trace.getSpanContext(parentContext);

    const automaticLink =
      relationship === 'link' && parentSpanContext ? [{ context: parentSpanContext }] : [];
    const span = this.tracer.startSpan(
      options.name,
      {
        kind: options.kind ?? this.options.operationSpanKind ?? SpanKind.INTERNAL,
        attributes: {
          ...this.options.commonAttributes,
          ...this.diagnostics.protect(
            'operationAttributes',
            () => ({ ...this.options.operationAttributes?.({ actor, event }) }),
            {},
          ),
          ...options.attributes,
          [this.keys.commandEvent]: event.type,
        },
        links: [...automaticLink, ...(options.links ?? [])],
      },
      relationship === 'child' ? parentContext : ROOT_CONTEXT,
    );
    const operationContext = trace.setSpan(
      relationship === 'child' ? parentContext : ROOT_CONTEXT,
      span,
    );
    return new OperationSpan(this, span, operationContext);
  }

  startWork(
    operation: OperationTelemetry,
    { name, input, self, options }: WorkStart<TracedWorkOptions>,
  ): WorkTelemetry {
    const parentContext = (operation as OperationSpan).context;
    const actorIdAttribute = this.actorIdAttribute();
    const configuredAttributes = this.diagnostics.protect(
      'workAttributes',
      () => ({ ...this.options.workAttributes?.({ name, input, self }) }),
      {},
    );

    const span = this.tracer.startSpan(
      name,
      {
        kind: this.options.workSpanKind ?? SpanKind.INTERNAL,
        attributes: {
          ...this.options.commonAttributes,
          ...configuredAttributes,
          ...options.attributes,
          ...(actorIdAttribute === false ? {} : { [actorIdAttribute]: self.id }),
        },
      },
      parentContext,
    );
    return new WorkSpan(this, span, trace.setSpan(parentContext, span));
  }

  actorIdAttribute(): string | false {
    return this.options.actorIdAttribute ?? this.keys.actorId;
  }

  recordStateValues(): boolean {
    return this.options.recordStateValues ?? true;
  }

  /** Deduplicated per span, since several paths can observe one failure. */
  recordFailure(span: Span, error: unknown, isEnded: () => boolean): boolean {
    if (isEnded() || this.failedSpans.has(span)) {
      return false;
    }
    this.failedSpans.add(span);
    const details = this.diagnostics.protect<FailureDetails>(
      'errorDetails',
      () => {
        const mapper = this.options.errorDetails;
        if (mapper === undefined) return defaultErrorDetails(error);
        const { type, message, stack, attributes } = mapper(error);
        return { type, message, stack, attributes: { ...attributes }, detailsUnavailable: false };
      },
      { detailsUnavailable: true },
    );
    // Application mappers/reporters can synchronously stop actors and end spans.
    if (isEnded()) return false;
    span.setStatus({
      code: SpanStatusCode.ERROR,
      ...(details.message === undefined ? {} : { message: details.message }),
    });
    const unavailableAttribute =
      this.options.detailsUnavailableAttribute ?? this.keys.errorDetailsUnavailable;
    if (details.detailsUnavailable && unavailableAttribute !== false) {
      span.setAttribute(unavailableAttribute, true);
    }
    const attributes: Attributes = {
      ...details.attributes,
      ...(details.type === undefined ? {} : { 'exception.type': details.type }),
      ...(details.message === undefined ? {} : { 'exception.message': details.message }),
      ...(details.stack === undefined ? {} : { 'exception.stacktrace': details.stack }),
    };
    if (Object.keys(attributes).length > 0) span.addEvent('exception', attributes);
    return true;
  }
}

class OperationSpan implements OperationTelemetry {
  private readonly backend: OtelTelemetry;
  private readonly span: Span;
  readonly context: Context;

  constructor(backend: OtelTelemetry, span: Span, context: Context) {
    this.backend = backend;
    this.span = span;
    this.context = context;
  }

  identify(id: number): void {
    this.span.setAttribute(this.backend.keys.operationId, id);
  }

  ids(): { traceId: string; spanId: string } {
    const { traceId, spanId } = this.span.spanContext();
    return { traceId, spanId };
  }

  link(): SpanContext {
    return this.span.spanContext();
  }

  run<T>(callback: () => T): T {
    return context.with(this.context, callback);
  }

  microstep(actor: ActorRefLike, event: AnyEventObject, stateValue: () => unknown): void {
    if (!this.span.isRecording()) {
      return;
    }
    const value = stateValue();
    const { keys } = this.backend;
    const actorIdAttribute = this.backend.actorIdAttribute();
    this.span.addEvent(keys.microstepEvent, {
      ...(actorIdAttribute === false ? {} : { [actorIdAttribute]: actorId(actor) }),
      [keys.eventType]: event.type,
      ...(!this.backend.recordStateValues() || value === undefined
        ? {}
        : { [keys.stateValue]: serializeStateValue(value) }),
    });
  }

  recipientTerminal(recipient: ActorRefLike, event: AnyEventObject, reason: TerminalReason): void {
    const { keys } = this.backend;
    const actorIdAttribute = this.backend.actorIdAttribute();
    this.span.addEvent(keys.recipientTerminalEvent, {
      ...(actorIdAttribute === false ? {} : { [actorIdAttribute]: actorId(recipient) }),
      [keys.eventType]: event.type,
      [keys.eventTerminalReason]: reason,
    });
  }

  recordFailure(error: unknown, isEnded: () => boolean): boolean {
    return this.backend.recordFailure(this.span, error, isEnded);
  }

  end({
    outcome,
    outcomeReason,
    hadError,
    errorCount,
    terminalRecipientEvents,
  }: OperationSummary): void {
    const { keys } = this.backend;
    this.span.setAttribute(keys.operationOutcome, outcome);
    if (outcomeReason !== undefined) {
      this.span.setAttribute(keys.operationOutcomeReason, outcomeReason);
    }
    if (hadError) {
      this.span.setAttribute(keys.operationHadError, true);
    }
    if (errorCount > 0) {
      this.span.setAttribute(keys.operationErrorCount, errorCount);
    }
    if (terminalRecipientEvents > 0) {
      this.span.setAttribute(keys.operationTerminalRecipientEventCount, terminalRecipientEvents);
    }
    this.span.end();
  }
}

class WorkSpan implements WorkTelemetry {
  private readonly backend: OtelTelemetry;
  private readonly span: Span;
  private readonly context: Context;

  constructor(backend: OtelTelemetry, span: Span, context: Context) {
    this.backend = backend;
    this.span = span;
    this.context = context;
  }

  run<T>(callback: () => T): T {
    return context.with(this.context, callback);
  }

  cancelled(): void {
    this.span.setAttribute(this.backend.keys.workOutcome, 'cancelled');
  }

  recordFailure(error: unknown, isEnded: () => boolean): boolean {
    return this.backend.recordFailure(this.span, error, isEnded);
  }

  end(): void {
    this.span.end();
  }
}

function serializeStateValue(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

function defaultErrorDetails(error: unknown): FailureDetails {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') {
    return {
      type: error === null ? 'null' : typeof error,
      message: String(error),
      detailsUnavailable: false,
    };
  }
  const { name, message, stack } = error as { name?: unknown; message?: unknown; stack?: unknown };
  return {
    type: typeof name === 'string' && name ? name : typeof error,
    message: typeof message === 'string' ? message : undefined,
    stack: typeof stack === 'string' ? stack : undefined,
    detailsUnavailable: typeof message !== 'string' && typeof stack !== 'string',
  };
}
