import { it } from 'vitest';
import { runScenario } from './scenarios/harness.js';
import { timersExample } from './scenarios/timers.example.js';
import { invokedExample } from './scenarios/invoked.example.js';
import { spawnedExample } from './scenarios/spawned.example.js';
import { raisedExample } from './scenarios/raised.example.js';
import { sendingExample } from './scenarios/sending.example.js';
import { longRunningExample } from './scenarios/long-running.example.js';

it('timers: verifies coverage and documented gaps', async () => {
  await runScenario('timers', timersExample, false);
});

it('invoked: verifies coverage and documented gaps', async () => {
  await runScenario('invoked', invokedExample, false);
});

it('spawned: verifies coverage and documented gaps', async () => {
  await runScenario('spawned', spawnedExample, false);
});

it('raised: verifies coverage and documented gaps', async () => {
  await runScenario('raised', raisedExample, false);
});

it('sending: verifies coverage and documented gaps', async () => {
  await runScenario('sending', sendingExample, false);
});

it('long-running: verifies coverage and documented gaps', async () => {
  await runScenario('long-running', longRunningExample, false);
});
