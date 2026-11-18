import { context } from '@opentelemetry/api';
import type { AnyActorRef } from 'xstate';
import { tracing } from './tracing.js';

declare const actor: AnyActorRef;

// The default: a new trace that links to the caller's span.
tracing.sendCommand(actor, { type: 'LOOKUP', sku: 'ABC-1' }, { name: 'inventory.check' });

// A child of the caller's span, for a caller that waits for the work.
tracing.sendCommand(
  actor,
  { type: 'LOOKUP', sku: 'ABC-1' },
  { name: 'inventory.check', relationship: 'child', parentContext: context.active() },
);
