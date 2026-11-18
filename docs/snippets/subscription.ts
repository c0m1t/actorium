import type { AnyActorRef } from 'xstate';
import { tracing } from './tracing.js';

interface Source {
  subscribe(receive: (payload: unknown) => void): () => void;
}

// Each message is its own command; the source's lifetime is not a span.
export function connect(target: AnyActorRef, source: Source): () => void {
  return source.subscribe((payload) => {
    tracing.sendCommand(target, { type: 'MESSAGE', payload }, { name: 'feed.message' });
  });
}
