export { XStateTracing, createXStateTracing } from './otel/xstate-tracing.js';
export { getAttributeKeys, DEFAULT_ATTRIBUTE_NAMESPACE } from './otel/attributes.js';
export type { AttributeKeys } from './otel/attributes.js';

export type {
  CommandEvent,
  CommandOutcome,
  CommandResult,
  CommandTrace,
  CreateXStateTracingOptions,
  ErrorDetails,
  FromPromiseOptions,
  PromiseActorArgs,
  ScheduledWorkPolicy,
  ScheduledWorkPolicyArgs,
  SendCommandOptions,
  ShouldTraceArgs,
  TelemetryDiagnostic,
  XStateTracingOptions,
} from './types.js';
