import { createActor, createMachine, type InspectionEvent } from 'xstate';
import { tracing } from './tracing.js';

declare function otherInspector(event: InspectionEvent): void;

const actor = createActor(createMachine({}), {
  inspect(event) {
    tracing.inspect(event); // never swallow its configuration errors
    try {
      otherInspector(event);
    } catch {
      console.warn('Additional inspector failed');
    }
  },
});
actor.start();
