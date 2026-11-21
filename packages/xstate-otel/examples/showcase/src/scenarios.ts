import { waitFor } from 'xstate';
import type { Showcase } from './showcase.ts';

export interface Scenario {
  id: string;
  title: string;
  /** What the trace demonstrates, with inline code and package-relative docs links. */
  shows: string;
  /** Runs inside the HTTP request span and resolves once its commands finished. */
  run(showcase: Showcase): Promise<Record<string, unknown>>;
}

const tea = { sku: 'TEA-1', quantity: 2 } as const;

export const scenarios: readonly Scenario[] = [
  {
    id: 'place-order',
    title: 'Place order (HTTP)',
    shows:
      'The request waits, so the operation is its [child](guide/commands#link-or-child). A relay starts the order actor, which reserves stock and charges in parallel, then notifies the customer.',
    async run({ desk }) {
      const { orderId, command } = desk.place({ ...tea, card: 'tok_ok' }, 'child');
      const result = await command.finished;
      return { orderId, ...result, state: desk.order(orderId)?.getSnapshot().value };
    },
  },
  {
    id: 'webhook',
    title: 'Webhook',
    shows:
      'A pay-later order waits for the payment provider. Each command is a new trace [linked](guide/commands#link-or-child) to the request that accepted it.',
    async run({ desk }) {
      const { orderId, command } = desk.place({ ...tea, card: 'tok_ok', payLater: true });
      await command.finished;
      const webhook = await desk.confirmPayment(orderId, 'pay-provider-1').finished;
      return { orderId, webhook, state: desk.order(orderId)?.getSnapshot().value };
    },
  },
  {
    id: 'payment-declined',
    title: 'Payment declined',
    shows:
      'The charge fails with mapped [`errorDetails`](reference/outcomes#error-details). The machine handles it, so the outcome stays completed with `hadError` and an error count.',
    async run({ desk }) {
      const { orderId, command } = desk.place({ ...tea, card: 'tok_declined' });
      const result = await command.finished;
      return { orderId, ...result, state: desk.order(orderId)?.getSnapshot().value };
    },
  },
  {
    id: 'cancel-while-charging',
    title: 'Cancel while charging',
    shows:
      'A cancel command stops the pending charge: its [`AbortSignal`](guide/promise-work#cancellation-and-deadlines) fires and the place command finishes cancelled.',
    async run({ desk, services }) {
      const { orderId, command } = desk.place({ ...tea, card: 'tok_hold' });
      await waitFor(desk.order(orderId)!, (snapshot) =>
        snapshot.matches({ processing: { stock: 'reserved', payment: 'charging' } }),
      );
      const aborted = services.payments.aborted;
      const cancel = desk.cancel(orderId);
      const [place, cancelResult] = await Promise.all([command.finished, cancel.finished]);
      return {
        orderId,
        place,
        cancel: cancelResult,
        chargeAborted: services.payments.aborted === aborted + 1,
      };
    },
  },
  {
    id: 'closed-order',
    title: 'Command to a closed order',
    shows:
      'The order has reached a final state, so XState refuses a late cancel: [`target_terminal`](reference/outcomes#outcomes).',
    async run({ desk }) {
      const { orderId, command } = desk.place({ ...tea, card: 'tok_ok' });
      await command.finished;
      return { orderId, cancel: await desk.cancel(orderId).finished };
    },
  },
  {
    id: 'reminder',
    title: 'Reminder after 2 s',
    shows:
      'An XState `after` timer scheduled by the place command fires later as its own [operation linked to the origin](guide/scheduled-work).',
    async run({ desk, waitForBookkeeping }) {
      const { orderId, command } = desk.place({ ...tea, card: 'tok_ok', payLater: true });
      await command.finished;
      await waitFor(
        desk.order(orderId)!,
        (snapshot) => snapshot.matches({ awaitingPayment: 'reminded' }),
        { timeout: 10_000 },
      );
      await waitForBookkeeping();
      return { orderId, state: desk.order(orderId)?.getSnapshot().value };
    },
  },
  {
    id: 'analytics',
    title: 'Analytics ping',
    shows:
      '[`shouldTrace`](guide/promise-work#choose-which-children-to-trace) skips heartbeat pings: the ping still runs, but has no span and does not hold its command open.',
    async run({ desk, services }) {
      const ping = await desk.track('ping').finished;
      const viewed = await desk.track('checkout_viewed').finished;
      return { ping, viewed, received: services.analytics.received.slice(-2) };
    },
  },
  {
    id: 'log-in-action',
    title: 'Log inside an action',
    shows:
      '[`withActiveOperation`](guide/actor-messages#actions) makes the operation span active in a synchronous action, so the log line carries its trace ID.',
    async run({ desk, logger }) {
      const command = desk.addNote('order-42', 'Leave at the back door');
      const result = await command.finished;
      const logCorrelated = logger.lines.some((line) => line.traceId === command.traceId);
      return { ...result, logCorrelated };
    },
  },
  {
    id: 'custom-namespace',
    title: 'Custom namespace',
    shows:
      'A runtime created with [`telemetryNamespace`](reference/attributes) set to `"shop.orders"` emits every attribute under that prefix.',
    async run({ shopDesk }) {
      const { orderId, command } = shopDesk.place({ ...tea, card: 'tok_ok' });
      return { orderId, ...(await command.finished) };
    },
  },
];
