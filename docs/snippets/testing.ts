import assert from 'node:assert/strict';
import { createXStateTracing, getAttributeKeys } from '@actorium/xstate-otel';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createActor, setup } from 'xstate';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracing = createXStateTracing({ tracer: provider.getTracer('test') });
const keys = getAttributeKeys();

const machine = setup({
  actors: { charge: tracing.fromPromise('payment.charge', async () => 'ok') },
}).createMachine({
  initial: 'idle',
  states: {
    idle: { on: { PAY: 'charging' } },
    charging: { invoke: { src: 'charge', onDone: 'paid' } },
    paid: {},
  },
});

const actor = createActor(machine, { inspect: tracing.inspect }).start();
const command = tracing.sendCommand(actor, { type: 'PAY' }, { name: 'order.pay' });

assert.deepEqual(await command.finished, { outcome: 'completed', hadError: false });
await tracing.settle(); // drain bookkeeping before reading spans

const [work, operation] = exporter.getFinishedSpans();
assert.equal(work?.name, 'payment.charge');
assert.equal(work?.parentSpanContext?.spanId, operation?.spanContext().spanId);
assert.equal(operation?.attributes[keys.operationOutcome], 'completed');
assert.equal(actor.getSnapshot().value, 'paid');
