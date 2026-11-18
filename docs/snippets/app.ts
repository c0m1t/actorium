// Stand-ins for application code that the snippets call. Declarations only:
// they typecheck the snippets without pretending to be real services.
import type { Context } from '@opentelemetry/api';
import type { AnyActorRef } from 'xstate';

export interface Reservation {
  reservationId: string;
}

export declare const inventory: {
  available(sku: string, options: { signal: AbortSignal }): Promise<number>;
  reserve(
    request: { sku: string; quantity: number },
    options: { signal: AbortSignal },
  ): Promise<Reservation>;
};
export declare const products: {
  load(sku: string, options: { signal: AbortSignal }): Promise<{ label: string }>;
};
export declare const auditLog: { write(entry: string): void };
export declare const sdk: { shutdown(): Promise<void> };
export declare function stopApplicationIngress(): Promise<void>;
export declare const ownedActors: AnyActorRef[];
export declare const orders: { get(orderId: string): AnyActorRef | undefined };
export declare function waitForOrderReply(orderId: string): Promise<unknown>;
export declare const bus: {
  publish(message: { data: unknown; headers: Record<string, string> }): Promise<void>;
  subscribe(
    receive: (message: { data: unknown; headers: Record<string, string> }) => void,
  ): () => void;
};
export declare function upstreamContext(): Context;
