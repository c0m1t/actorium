import assert from 'node:assert/strict';
import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SimulatedClock, type AnyActorRef } from 'xstate';
import { XStateTracing, type OperationTrace } from '../../src/index.js';
import { printSpanForest } from './trace-tree.js';

function createHarness() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer('edge-cases');
  const tracing = new XStateTracing(tracer, { recordMicrosteps: true });
  const clock = new SimulatedClock();
  const actors: AnyActorRef[] = [];
  const findings: string[] = [];
  const calls: string[] = [];
  const spans = () => exporter.getFinishedSpans();
  return {
    tracer,
    tracing,
    clock,
    findings,
    calls,
    spans,
    own<T extends AnyActorRef>(actor: T): T {
      actors.push(actor);
      return actor;
    },
    work(name: string) {
      return tracing.fromPromise(
        name,
        async (_args: { input: Record<string, never>; signal: AbortSignal; self: AnyActorRef }) => {
          calls.push(name);
          await Promise.resolve();
          return name;
        },
      );
    },
    async flush() {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    },
    async advance(ms: number) {
      clock.increment(ms);
      for (let i = 0; i < 30; i++) await Promise.resolve();
    },
    has(name: string) {
      return spans().some((s) => s.name === name);
    },
    child(name: string, command: OperationTrace) {
      const span = spans().find((s) => s.name === name);
      assert.ok(span, `Missing span: ${name}`);
      assert.equal(span.parentSpanContext?.spanId, command.spanId);
    },
    async close() {
      for (const actor of actors.reverse()) actor.stop();
      await provider.shutdown();
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;
export type Scenario = (h: Harness) => Promise<void>;

export async function runScenario(title: string, scenario: Scenario, print = true) {
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  const h = createHarness();
  try {
    await scenario(h);
    await h.flush();
    if (print) {
      printSpanForest(title, h.spans());
      for (const finding of h.findings) console.log(`  ${finding}`);
      console.log('Assertions passed (including assertions documenting known gaps).');
    }
    return h.findings;
  } finally {
    await h.close();
    context.disable();
    manager.disable();
  }
}
