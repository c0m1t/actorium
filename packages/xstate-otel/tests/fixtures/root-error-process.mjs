import assert from 'node:assert/strict';
import { trace } from '@opentelemetry/api';
import { createActor, fromCallback, fromObservable, fromPromise, setup } from 'xstate';

const [mode, scenario, reporter, outcome, value, observer, observerTarget = 'root'] =
  process.argv.slice(2);
const failure = value === 'string' ? 'ORIGINAL_ROOT_FAILURE' : new Error('ORIGINAL_ROOT_FAILURE');
const fail = () => {
  throw failure;
};
let observed = 0;
let reported = 0;
let emitted;
const assertFailure = (error) => {
  if (scenario === 'guard') assert.match(error.message, /Unable to evaluate guard/);
  else assert.equal(error, failure);
};
const runtime =
  mode === 'traced'
    ? new (await import(process.env.TRACING_RUNTIME)).XStateTracing(
        trace.getTracer('no-sdk'),
        reporter === 'default'
          ? {}
          : {
              onDiagnostic: ({ error, phase }) => {
                assertFailure(error);
                reported++;
                emitted = error;
                console.log('REPORT', phase, 'ORIGINAL');
                if (reporter === 'throwing') throw new Error('REPORTER_FAILURE');
              },
            },
      )
    : undefined;
function subscribe(actor) {
  if (observer === 'error' || observer === 'both')
    actor.subscribe({
      error: (error) => {
        assertFailure(error);
        observed++;
        console.log('APPLICATION_ORIGINAL');
      },
    });
  if (observer === 'next' || observer === 'both') actor.subscribe(() => {});
}
const inspection = [];
const options = {
  inspect: (event) => {
    if (mode === 'traced') runtime.inspect(event);
    if (event.type === '@xstate.snapshot' && event.snapshot.status === 'error')
      inspection.push(true);
    if (
      observerTarget === 'child' &&
      event.type === '@xstate.actor' &&
      event.actorRef.id === 'worker'
    )
      subscribe(event.actorRef);
  },
};
const isPromise = scenario.includes('promise');
const handled = scenario.startsWith('handled-');
const child = isPromise
  ? mode === 'traced'
    ? runtime.fromPromise('work', async () => fail())
    : fromPromise(async () => fail())
  : fromCallback(fail);
const nested = setup({ actors: { child } }).createMachine({ invoke: { src: 'child' } });
const machine = setup({ actors: { child, nested } }).createMachine({
  ...(scenario === 'context' ? { context: fail } : {}),
  ...(scenario === 'startup' ? { entry: fail } : {}),
  initial: 'idle',
  states: {
    idle: {
      on: {
        FAIL: ['child', 'handled-child', 'promise', 'handled-promise', 'nested-startup'].includes(
          scenario,
        )
          ? 'working'
          : scenario === 'guard'
            ? { guard: fail }
            : { actions: fail },
      },
    },
    working: {
      invoke: {
        id: 'worker',
        src: scenario === 'nested-startup' ? 'nested' : 'child',
        ...(handled ? { onError: 'recovered' } : {}),
      },
    },
    recovered: {},
  },
});
const logic =
  scenario === 'callback-root'
    ? fromCallback(fail)
    : scenario === 'observable-root'
      ? fromObservable(() => ({
          subscribe: ({ error }) => {
            queueMicrotask(() => error(failure));
            return { unsubscribe() {} };
          },
        }))
      : machine;
const actor = createActor(logic, {
  ...options,
  ...(scenario === 'restored-error'
    ? {
        snapshot: {
          ...createActor(machine).getPersistedSnapshot(),
          status: 'error',
          error: failure,
        },
      }
    : {}),
});
if (observerTarget === 'root') subscribe(actor);
actor.start();
if (
  !['context', 'startup', 'callback-root', 'observable-root', 'restored-error'].includes(scenario)
) {
  if (mode === 'traced' && outcome !== 'outside') {
    const result = await runtime.sendCommand(actor, { type: 'FAIL' }, { name: 'failure' }).finished;
    assert.deepEqual(result, {
      outcome: !handled && outcome === 'failed' ? 'failed' : 'completed',
      hadError: true,
    });
    console.log('RESULT', JSON.stringify(result));
  } else actor.send({ type: 'FAIL' });
}
// Let Promise rejection, deferred lifecycle checks and command finalization settle
// before checking instrumentation. XState's native throw remains a real timer.
for (let tick = 0; tick < 12; tick++) await Promise.resolve();
assert.equal(
  observed,
  ['error', 'both'].includes(observer) && (!handled || observerTarget === 'child') ? 1 : 0,
);
assert.equal(reported, mode === 'traced' && reporter !== 'default' && !handled ? 1 : 0);
if (emitted !== undefined) assert.equal(emitted, actor.getSnapshot().error);
if (mode === 'traced') {
  // White-box cleanup checks against the private lifecycle runtime.
  const lifecycle = runtime.runtime;
  for (const [field, table] of Object.entries({
    processing: lifecycle.processing,
    queued: lifecycle.queued,
    actorWorkRegistrations: lifecycle.actorWorkRegistrations,
    timersByActor: lifecycle.timers.timersByActor,
    actorOperations: lifecycle.actorOperations,
  }))
    assert.equal(table.has(actor), false, field);
}
console.log('INSPECTION_ERRORS', JSON.stringify(inspection));
console.log('CHECKED');
setTimeout(() => console.log('SURVIVED'), 5);
