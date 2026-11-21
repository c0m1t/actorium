// Runs in a clean project that installed the packed tarball (see check-package.mjs).
import assert from 'node:assert/strict';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  createXStateTracing,
  getTelemetryNames,
  type OperationResult,
} from '@actorium/xstate-otel';
import manifest from '@actorium/xstate-otel/package.json' with { type: 'json' };
import { createActor, setup } from 'xstate';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracing = createXStateTracing({ tracer: provider.getTracer('smoke') });

const machine = setup({
  types: { events: {} as { type: 'RUN' } },
  actors: { work: tracing.fromPromise('smoke.work', async () => 'done') },
}).createMachine({
  initial: 'idle',
  states: {
    idle: { on: { RUN: 'working' } },
    working: { invoke: { src: 'work', onDone: 'done' } },
    done: { type: 'final' },
  },
});
const actor = createActor(machine, { inspect: tracing.inspect }).start();

// Never called: the published declarations must keep command events typed.
export function rejectsUnknownEvents(): void {
  // @ts-expect-error -- STOP is not an event of this machine
  tracing.sendCommand(actor, { type: 'STOP' }, { name: 'invalid' });
}

const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'smoke.run' });
const result: OperationResult = await command.finished;
await tracing.waitForBookkeeping();

assert.deepEqual(result, { outcome: 'completed', hadError: false });
const spans = exporter.getFinishedSpans();
assert.deepEqual(
  spans.map((span) => span.name),
  ['smoke.work', 'smoke.run'],
);
assert.equal(spans[1]?.attributes[getTelemetryNames().operationOutcome], 'completed');
console.log(`${manifest.name}@${manifest.version}: tarball smoke test passed`);
