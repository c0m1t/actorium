/** Default namespace for every attribute, span-event and span name this package emits. */
export const DEFAULT_ATTRIBUTE_NAMESPACE = 'actorium.xstate';

// The single table of emitted names, relative to the namespace. Standard
// OpenTelemetry names (`exception`, `exception.*`) are never namespaced.
const names = {
  /** Operation span: type of the event that started the command. */
  commandEvent: 'command.event',
  /** Operation span: numeric operation id, unique per XStateTracing instance. */
  operationId: 'operation.id',
  /** Operation span: `completed`, `cancelled`, `failed`, `target_terminal` or `unobserved`. */
  operationOutcome: 'operation.outcome',
  /** Operation span: why a command ended `target_terminal` or `unobserved`. */
  operationOutcomeReason: 'operation.outcome_reason',
  /** Operation span: present and true when any traced work failed. */
  operationHadError: 'operation.had_error',
  /** Operation span: number of failed work/operation records. */
  operationErrorCount: 'operation.error_count',
  /** Operation span: relays sent to recipients already terminal. */
  operationTerminalRecipientEventCount: 'operation.terminal_recipient_event_count',
  /** Work spans and span events: id of the actor involved. */
  actorId: 'actor.id',
  /** Span events: type of the event involved. */
  eventType: 'event.type',
  /** Recipient-terminal span events: `done`, `error` or `stopped`. */
  eventTerminalReason: 'event.terminal_reason',
  /** Microstep events: serialized state value. */
  stateValue: 'state.value',
  /** Work span: `cancelled` when the work was aborted or stopped. */
  workOutcome: 'work.outcome',
  /** Failed spans: true when no error message or stack was available. */
  errorDetailsUnavailable: 'error.details_unavailable',
  /** Scheduled operation span: `xstate.raise` or `xstate.sendTo`. */
  scheduledAction: 'scheduled.action',
  /** Scheduled operation span: configured delay in milliseconds. */
  scheduledDelayMs: 'scheduled.delay_ms',
  /** Scheduled operation span: id of the operation that scheduled the work. */
  scheduledOriginOperationId: 'scheduled.origin_operation_id',
  /** Operation span event: one per microstep when `recordMicrosteps` is set. */
  microstepEvent: 'microstep',
  /** Operation span event: a relay sent to a recipient already terminal. */
  recipientTerminalEvent: 'event.recipient_terminal',
  /** Span name: default for operations started by delayed work. */
  scheduledSpan: 'scheduled',
} as const;

export type AttributeKeys = { readonly [K in keyof typeof names]: string };

const namespacePattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * Returns every attribute, span-event and span name emitted under `namespace`,
 * for building queries and dashboards. Throws for a namespace that is not
 * lowercase, dot-separated snake_case (for example `acme.workflows`).
 */
export function getAttributeKeys(namespace: string = DEFAULT_ATTRIBUTE_NAMESPACE): AttributeKeys {
  if (typeof namespace !== 'string' || !namespacePattern.test(namespace)) {
    throw new TypeError(
      `Invalid attributeNamespace ${JSON.stringify(namespace)}: use lowercase, dot-separated snake_case segments such as "acme.workflows"`,
    );
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(names).map(([key, name]) => [key, `${namespace}.${name}`]),
    ) as AttributeKeys,
  );
}
