import { assign, setup } from 'xstate';
import { XStateTracing } from '../../../src/index.js';

export interface Product {
  id: string;
  requiresRescan: boolean;
}

export interface Basket {
  id: string;
  itemCount: number;
}

export interface CheckoutServices {
  loadProduct(barcode: string, signal: AbortSignal): Promise<Product>;
  addProduct(productId: string, signal: AbortSignal): Promise<Basket>;
}

interface CheckoutContext {
  workflowId: string;
  barcode: string | undefined;
  product: Product | undefined;
  basket: Basket | undefined;
  error: unknown | undefined;
}

type CheckoutEvent =
  | { type: 'ADD_ITEM'; barcode: string }
  | { type: 'RESCAN'; barcode: string }
  | { type: 'CANCEL' };

export function createCheckoutMachine(tracing: XStateTracing, services: CheckoutServices) {
  const loadProduct = tracing.fromPromise<Product, { barcode: string }>(
    'product.lookup',
    async ({ input, signal }) => {
      return services.loadProduct(input.barcode, signal);
    },
  );

  const addProduct = tracing.fromPromise<Basket, { productId: string }>(
    'basket.add_item',
    async ({ input, signal }) => {
      return services.addProduct(input.productId, signal);
    },
  );

  return setup({
    types: {
      context: {} as CheckoutContext,
      events: {} as CheckoutEvent,
      input: {} as { workflowId: string },
    },
    actors: {
      loadProduct,
      addProduct,
    },
    guards: {
      requiresRescan: ({ context }) => context.product?.requiresRescan === true,
    },
    actions: {
      acceptAddItem: assign({
        barcode: ({ event }) => (event.type === 'ADD_ITEM' ? event.barcode : undefined),
        product: () => undefined,
        basket: () => undefined,
        error: () => undefined,
      }),
      acceptRescan: assign({
        barcode: ({ event }) => (event.type === 'RESCAN' ? event.barcode : undefined),
        product: () => undefined,
        error: () => undefined,
      }),
    },
  }).createMachine({
    id: 'checkout',
    context: ({ input }) => ({
      workflowId: input.workflowId,
      barcode: undefined,
      product: undefined,
      basket: undefined,
      error: undefined,
    }),
    initial: 'idle',
    states: {
      idle: {
        on: {
          ADD_ITEM: {
            target: 'validating',
            actions: 'acceptAddItem',
          },
        },
      },

      // Deliberately transient: this demonstrates that tracing does not need to
      // know or enumerate intermediate state names.
      validating: {
        always: 'loadingProduct',
      },

      loadingProduct: {
        invoke: {
          id: 'loadProduct',
          src: 'loadProduct',
          input: ({ context }) => ({
            barcode: context.barcode!,
          }),
          onDone: {
            target: 'decidingProduct',
            actions: assign({
              product: ({ event }) => event.output,
            }),
          },
          onError: {
            target: 'failed',
            actions: assign({
              error: ({ event }) => event.error,
            }),
          },
        },
        on: {
          CANCEL: 'idle',
        },
      },

      decidingProduct: {
        always: [
          {
            guard: 'requiresRescan',
            target: 'waitingForRescan',
          },
          {
            target: 'addingProduct',
          },
        ],
      },

      // Passive waiting state: no special telemetry annotation is needed. Since
      // there is no finite continuation after the product onDone macrostep, the
      // current operation ends automatically.
      waitingForRescan: {
        on: {
          RESCAN: {
            target: 'validating',
            actions: 'acceptRescan',
          },
          CANCEL: 'idle',
        },
      },

      addingProduct: {
        invoke: {
          id: 'addProduct',
          src: 'addProduct',
          input: ({ context }) => ({
            productId: context.product!.id,
          }),
          onDone: {
            target: 'ready',
            actions: assign({
              basket: ({ event }) => event.output,
            }),
          },
          onError: {
            target: 'failed',
            actions: assign({
              error: ({ event }) => event.error,
            }),
          },
        },
        on: {
          CANCEL: 'idle',
        },
      },

      ready: {
        on: {
          ADD_ITEM: {
            target: 'validating',
            actions: 'acceptAddItem',
          },
        },
      },

      failed: {
        on: {
          ADD_ITEM: {
            target: 'validating',
            actions: 'acceptAddItem',
          },
        },
      },
    },
  });
}
