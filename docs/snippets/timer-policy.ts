import { trace } from '@opentelemetry/api';
import { createXStateTracing } from '@actorium/xstate-otel';
import { createActor, setup, SimulatedClock } from 'xstate';

const tracing = createXStateTracing({
  tracer: trace.getTracer('editor'),
  // Any policy installs the scheduler integration; a callback can decide per timer.
  timerPolicy: { mode: 'new-linked-operation', name: 'editor.autosave' },
});

const save = tracing.fromPromise('document.save', async () => {});

const machine = setup({ actors: { save } }).createMachine({
  initial: 'editing',
  states: {
    editing: { on: { EDIT: 'debouncing' } },
    debouncing: {
      after: { 500: 'saving' }, // fires as a new operation, linked to the edit
      on: { EDIT: { target: 'debouncing', reenter: true } }, // restarts the timer
    },
    saving: { invoke: { src: 'save', onDone: 'editing' } },
  },
});

// The stock clock or a mutable SimulatedClock; frozen clocks are rejected.
const clock = new SimulatedClock();
const actor = createActor(machine, { clock, inspect: tracing.inspect }).start();
await tracing.sendCommand(actor, { type: 'EDIT' }, { name: 'editor.edit' }).finished;
clock.increment(500); // advance between actor calls, never inside an action
