import { getTelemetryNames, DEFAULT_TELEMETRY_NAMESPACE } from '@actorium/xstate-otel';

const names = getTelemetryNames();
console.log(names.operationOutcome); // 'actorium.xstate.operation.outcome'
console.log(DEFAULT_TELEMETRY_NAMESPACE); // 'actorium.xstate'

// The same namespace you pass to createXStateTracing({ telemetryNamespace }).
const custom = getTelemetryNames('acme.workflows');
export const failedOperations = `${custom.operationOutcome} = "failed"`;
