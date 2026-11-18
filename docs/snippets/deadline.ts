import { tracing } from './tracing.js';

export const boundedLookup = tracing.fromPromise<unknown, { url: string }>(
  'service.lookup',
  async ({ input, signal }) => {
    // Stop on actor cancellation or after five seconds, whichever comes first.
    const response = await fetch(input.url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) throw new Error(`Lookup failed with ${response.status}`);
    return response.json(); // body consumption belongs to the traced work
  },
);
