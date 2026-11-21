import type { OperationTrace, XStateTracing } from '@actorium/xstate-otel';
import {
  assertEvent,
  assign,
  createActor,
  sendParent,
  sendTo,
  setup,
  spawnChild,
  type ActorRefFrom,
} from 'xstate';
import type { Logger } from './logger.ts';
import type { Card, Services } from './services.ts';

export interface OrderRequest {
  sku: string;
  quantity: number;
  card: Card;
  /** Reserve stock now and wait for a payment webhook instead of charging. */
  payLater?: boolean;
}

type ClosedStatus = 'placed' | 'declined' | 'cancelled';

export interface OrderDeskOptions {
  tracing: XStateTracing;
  services: Services;
  logger: Logger;
  /** Prefix for generated order IDs. */
  idPrefix: string;
  reminderDelayMs: number;
}

/**
 * A long-lived `orders` actor that spawns one `order` actor per order. The
 * machines are built per tracing runtime because `tracing.fromPromise` wraps
 * the Promise logic they invoke.
 */
export function createOrderDesk({
  tracing,
  services,
  logger,
  idPrefix,
  reminderDelayMs,
}: OrderDeskOptions) {
  const reserveStock = tracing.fromPromise<
    { reservationId: string },
    { sku: string; quantity: number }
  >('order.reserve_stock', ({ input, signal }) => services.inventory.reserve(input, { signal }));
  const chargePayment = tracing.fromPromise<{ paymentId: string }, { orderId: string; card: Card }>(
    'order.charge_payment',
    ({ input, signal }) => services.payments.charge(input, { signal }),
  );
  const notifyCustomer = tracing.fromPromise<
    void,
    { orderId: string; template: 'confirmation' | 'payment_reminder' }
  >('order.notify_customer', ({ input, signal }) => services.notifier.send(input, { signal }));
  // Heartbeat pings still run, but get no span and never hold a command open.
  const sendAnalytics = tracing.fromPromise<void, { name: string }>(
    'analytics.send',
    ({ input, signal }) => services.analytics.track(input, { signal }),
    { shouldTrace: ({ input }) => input.name !== 'ping' },
  );

  const order = setup({
    types: {
      input: {} as { orderId: string } & OrderRequest,
      context: {} as {
        orderId: string;
        request: OrderRequest;
        reservationId?: string;
        paymentId?: string;
      },
      events: {} as
        | { type: 'SUBMIT' }
        | { type: 'PAYMENT_CONFIRMED'; paymentId: string }
        | { type: 'CANCEL' },
    },
    actors: { reserveStock, chargePayment, notifyCustomer },
    guards: { paysLater: ({ context }) => context.request.payLater === true },
    delays: { reminder: reminderDelayMs },
    actions: {
      close: sendParent((_, status: ClosedStatus) => ({ type: 'ORDER_CLOSED', status })),
    },
  }).createMachine({
    id: 'order',
    context: ({ input: { orderId, ...request } }) => ({ orderId, request }),
    initial: 'draft',
    states: {
      draft: { on: { SUBMIT: 'processing' } },
      processing: {
        type: 'parallel',
        on: { CANCEL: 'cancelled' },
        onDone: [{ guard: 'paysLater', target: 'awaitingPayment' }, { target: 'notifying' }],
        states: {
          stock: {
            initial: 'reserving',
            states: {
              reserving: {
                invoke: {
                  id: 'reserveStock',
                  src: 'reserveStock',
                  input: ({ context }) => ({
                    sku: context.request.sku,
                    quantity: context.request.quantity,
                  }),
                  onDone: {
                    target: 'reserved',
                    actions: assign({ reservationId: ({ event }) => event.output.reservationId }),
                  },
                },
              },
              reserved: { type: 'final' },
            },
          },
          payment: {
            initial: 'routing',
            states: {
              routing: {
                always: [{ guard: 'paysLater', target: 'deferred' }, { target: 'charging' }],
              },
              charging: {
                invoke: {
                  id: 'chargePayment',
                  src: 'chargePayment',
                  input: ({ context }) => ({
                    orderId: context.orderId,
                    card: context.request.card,
                  }),
                  onDone: {
                    target: 'charged',
                    actions: assign({ paymentId: ({ event }) => event.output.paymentId }),
                  },
                  // A declined card is a business outcome, handled here.
                  onError: '#order.declined',
                },
              },
              charged: { type: 'final' },
              deferred: { type: 'final' },
            },
          },
        },
      },
      awaitingPayment: {
        on: {
          PAYMENT_CONFIRMED: {
            target: 'notifying',
            actions: assign({ paymentId: ({ event }) => event.paymentId }),
          },
          CANCEL: 'cancelled',
        },
        initial: 'waiting',
        states: {
          // Scheduled during the place command; fires as a new linked operation.
          waiting: { after: { reminder: 'reminding' } },
          reminding: {
            invoke: {
              id: 'sendReminder',
              src: 'notifyCustomer',
              input: ({ context }) => ({
                orderId: context.orderId,
                template: 'payment_reminder' as const,
              }),
              onDone: 'reminded',
              onError: 'reminded',
            },
          },
          reminded: {},
        },
      },
      notifying: {
        invoke: {
          id: 'notifyCustomer',
          src: 'notifyCustomer',
          input: ({ context }) => ({ orderId: context.orderId, template: 'confirmation' as const }),
          onDone: 'placed',
          onError: 'placed',
        },
      },
      placed: { type: 'final', entry: { type: 'close', params: 'placed' } },
      declined: { type: 'final', entry: { type: 'close', params: 'declined' } },
      cancelled: { type: 'final', entry: { type: 'close', params: 'cancelled' } },
    },
  });

  type OrderRef = ActorRefFrom<typeof order>;

  const orders = setup({
    types: {
      context: {} as { orders: Record<string, OrderRef>; closed: number; tracked: number },
      events: {} as
        | { type: 'PLACE'; orderId: string; request: OrderRequest }
        | { type: 'ORDER_CLOSED'; status: ClosedStatus }
        | { type: 'TRACK'; name: string }
        | { type: 'ADD_NOTE'; orderId: string; text: string },
    },
    actors: { order, sendAnalytics },
  }).createMachine({
    id: 'orders',
    context: { orders: {}, closed: 0, tracked: 0 },
    on: {
      PLACE: {
        actions: [
          assign({
            orders: ({ context, event, spawn }) => ({
              ...context.orders,
              [event.orderId]: spawn('order', {
                id: event.orderId,
                input: { orderId: event.orderId, ...event.request },
              }),
            }),
          }),
          // An immediate relay: it joins the place command's operation.
          sendTo(({ context, event }) => context.orders[event.orderId]!, { type: 'SUBMIT' }),
        ],
      },
      ORDER_CLOSED: { actions: assign({ closed: ({ context }) => context.closed + 1 }) },
      TRACK: {
        actions: [
          assign({ tracked: ({ context }) => context.tracked + 1 }),
          spawnChild('sendAnalytics', {
            id: ({ context }) => `analytics-${context.tracked}`,
            input: ({ event }) => {
              assertEvent(event, 'TRACK');
              return { name: event.name };
            },
          }),
        ],
      },
      ADD_NOTE: {
        actions: ({ self, event }) =>
          // Make the operation span active so the logger can correlate the line.
          tracing.withActiveOperation(self, () =>
            logger.info('note added', { 'order.id': event.orderId, 'note.text': event.text }),
          ),
      },
    },
  });

  const desk = createActor(orders, { id: 'orders', inspect: tracing.inspect }).start();
  let nextId = 0;

  /** Looks up an order actor, including closed ones. */
  const findOrder = (orderId: string): OrderRef | undefined =>
    desk.getSnapshot().context.orders[orderId];
  const requireOrder = (orderId: string): OrderRef => {
    const ref = findOrder(orderId);
    if (!ref) throw new Error(`Unknown order ${orderId}`);
    return ref;
  };

  // Every entry point is a command; plain `send` would not be traced.
  return {
    tracing,
    order: findOrder,
    place(request: OrderRequest, relationship: 'link' | 'child' = 'link') {
      const orderId = `${idPrefix}-${++nextId}`;
      const command = tracing.sendCommand(
        desk,
        { type: 'PLACE', orderId, request },
        { name: 'order.place', relationship, attributes: { 'order.id': orderId } },
      );
      return { orderId, command };
    },
    confirmPayment: (orderId: string, paymentId: string): OperationTrace =>
      tracing.sendCommand(
        requireOrder(orderId),
        { type: 'PAYMENT_CONFIRMED', paymentId },
        { name: 'payment.confirm', attributes: { 'order.id': orderId } },
      ),
    cancel: (orderId: string): OperationTrace =>
      tracing.sendCommand(
        requireOrder(orderId),
        { type: 'CANCEL' },
        { name: 'order.cancel', attributes: { 'order.id': orderId } },
      ),
    track: (name: string): OperationTrace =>
      tracing.sendCommand(desk, { type: 'TRACK', name }, { name: 'analytics.track' }),
    addNote: (orderId: string, text: string): OperationTrace =>
      tracing.sendCommand(
        desk,
        { type: 'ADD_NOTE', orderId, text },
        { name: 'order.add_note', attributes: { 'order.id': orderId } },
      ),
    stop(): void {
      desk.stop();
    },
  };
}
