import { ownedActors, sdk, stopApplicationIngress } from './app.js';
import { tracing } from './tracing.js';

await stopApplicationIngress();
for (const actor of ownedActors) actor.stop();
await tracing.settle(); // queued tracing bookkeeping, not business work
await sdk.shutdown(); // the application owns export
