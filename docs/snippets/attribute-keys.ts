import { getAttributeKeys, DEFAULT_ATTRIBUTE_NAMESPACE } from '@actorium/xstate-otel';

const keys = getAttributeKeys();
console.log(keys.operationOutcome); // 'actorium.xstate.operation.outcome'
console.log(DEFAULT_ATTRIBUTE_NAMESPACE); // 'actorium.xstate'

// The same namespace you pass to createXStateTracing({ attributeNamespace }).
const custom = getAttributeKeys('acme.workflows');
export const failedOperations = `${custom.operationOutcome} = "failed"`;
