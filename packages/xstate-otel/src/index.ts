export { XStateTracing, createXStateTracing } from './otel/xstate-tracing.js';
export { getTelemetryNames, DEFAULT_TELEMETRY_NAMESPACE } from './otel/attributes.js';
export type { TelemetryNames } from './otel/attributes.js';

export type {
  CommandEvent,
  CreateXStateTracingOptions,
  ErrorDetails,
  FromPromiseOptions,
  OperationOutcome,
  OperationResult,
  OperationTrace,
  PromiseActorArgs,
  SendCommandOptions,
  ShouldTraceArgs,
  TelemetryDiagnostic,
  TimerPolicy,
  TimerPolicyArgs,
  XStateTracingOptions,
} from './types.js';
