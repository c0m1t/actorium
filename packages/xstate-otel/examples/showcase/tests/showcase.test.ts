import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { LogLine } from '../src/logger.ts';
import { scenarios } from '../src/scenarios.ts';
import { createShowcaseServer } from '../src/server.ts';
import { createShowcase } from '../src/showcase.ts';
import { startTelemetry } from '../src/telemetry.ts';
import type { SpanView, TraceView } from '../src/trace-tree.ts';

const telemetry = startTelemetry({});
const logs: LogLine[] = [];
const showcase = createShowcase({
  tracer: telemetry.tracer,
  reminderDelayMs: 50,
  log: (line) => logs.push(line),
});
const server = createShowcaseServer(telemetry, showcase);
let baseUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  showcase.stop();
  await showcase.settle();
  await telemetry.shutdown();
});

interface RunResponse {
  result: Record<string, unknown>;
  logs: LogLine[];
  traces: TraceView[];
}

// The server settles both tracing runtimes before it ends the request span
// and collects the traces connected to it, so every operation has ended here.
async function run(id: string): Promise<RunResponse> {
  const response = await fetch(`${baseUrl}/api/scenarios/${id}`, { method: 'POST' });
  expect(response.status).toBe(200);
  return (await response.json()) as RunResponse;
}

// IDs and timings vary between runs; the outline keeps names and structure.
// The request trace comes first; the others are sorted by content, because
// start times are only approximate across traces.
const volatile = /(^|\.)(operation\.id|scheduled\.origin_operation_id)$/;

function outline(traces: TraceView[]): string {
  const format = (attributes: Record<string, unknown>) =>
    Object.entries(attributes)
      .filter(([key]) => !volatile.test(key))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
  const visit = (span: SpanView, depth: number, lines: string[]) => {
    const pad = '  '.repeat(depth);
    const status = span.status === 'error' ? ` ERROR(${span.statusMessage ?? ''})` : '';
    lines.push(`${pad}${span.name} [${span.kind}]${status} ${format(span.attributes)}`.trimEnd());
    for (const { name, attributes } of span.events) {
      if (name.endsWith('.microstep')) {
        const [actor, event, state] = ['.actor.id', '.event.type', '.state.value'].map((suffix) =>
          String(Object.entries(attributes).find(([key]) => key.endsWith(suffix))?.[1]),
        );
        lines.push(`${pad}  · microstep ${actor}: ${event} → ${state}`);
      } else {
        lines.push(`${pad}  · ${name} ${format(attributes)}`.trimEnd());
      }
    }
    for (const link of span.links) lines.push(`${pad}  → link ${link.name ?? '?'}`);
    for (const child of span.children) visit(child, depth + 1, lines);
    return lines;
  };
  const blocks = traces.map((trace) =>
    trace.roots.flatMap((root) => visit(root, 1, [])).join('\n'),
  );
  const [request, ...others] = blocks;
  return `\n${[request, ...others.sort()].map((block) => `trace\n${block}`).join('\n')}\n`;
}

const find = (traces: TraceView[], name: string): SpanView[] => {
  const found: SpanView[] = [];
  const visit = (span: SpanView) => {
    if (span.name === name) found.push(span);
    span.children.forEach(visit);
  };
  traces.forEach((trace) => trace.roots.forEach(visit));
  return found;
};

describe('showcase scenarios', () => {
  test('the page and scenario list are served', async () => {
    const page = await fetch(baseUrl);
    expect(page.headers.get('content-type')).toContain('text/html');
    const list = (await (await fetch(`${baseUrl}/api/scenarios`)).json()) as { id: string }[];
    expect(list.map(({ id }) => id)).toEqual(scenarios.map(({ id }) => id));
  });

  test('place order (HTTP)', async () => {
    const { result, traces } = await run('place-order');
    expect(result).toMatchObject({ outcome: 'completed', hadError: false, state: 'placed' });
    // Stock and payment run in parallel under the operation.
    const [reserve] = find(traces, 'order.reserve_stock');
    const [charge] = find(traces, 'order.charge_payment');
    expect(charge!.startMs).toBeLessThan(reserve!.startMs + reserve!.durationMs);
    expect(outline(traces)).toMatchInlineSnapshot(`
      "
      trace
        POST /api/scenarios/:id [server] http.request.method=POST http.route=/api/scenarios/:id url.path=/api/scenarios/place-order http.response.status_code=200
          order.place [internal] order.id=order-1 actorium.xstate.command.event=PLACE actorium.xstate.operation.outcome=completed
            · microstep orders: PLACE → {}
            · microstep order-1: SUBMIT → {"processing":{"stock":"reserving","payment":"routing"}}
            · microstep order-1: SUBMIT → {"processing":{"stock":"reserving","payment":"charging"}}
            · microstep order-1: xstate.done.actor.reserveStock → {"processing":{"stock":"reserved","payment":"charging"}}
            · microstep order-1: xstate.done.state.order.processing.stock → {"processing":{"stock":"reserved","payment":"charging"}}
            · microstep order-1: xstate.done.actor.chargePayment → {"processing":{"stock":"reserved","payment":"charged"}}
            · microstep order-1: xstate.done.state.order.processing.payment → {"processing":{"stock":"reserved","payment":"charged"}}
            · microstep order-1: xstate.done.state.order.processing → notifying
            · microstep order-1: xstate.done.actor.notifyCustomer → placed
            · microstep orders: ORDER_CLOSED → {}
            · microstep orders: xstate.done.actor.order-1 → {}
            order.reserve_stock [internal] actorium.xstate.actor.id=reserveStock
              POST inventory/reservations [client]
            order.charge_payment [internal] actorium.xstate.actor.id=chargePayment
              POST payments/charges [client]
            order.notify_customer [internal] actorium.xstate.actor.id=notifyCustomer
              POST notifications [client]
      "
    `);
  });

  test('webhook', async () => {
    const { result, traces } = await run('webhook');
    expect(result).toMatchObject({
      webhook: { outcome: 'completed', hadError: false },
      state: 'placed',
    });
    expect(outline(traces)).toMatchInlineSnapshot(`
      "
      trace
        POST /api/scenarios/:id [server] http.request.method=POST http.route=/api/scenarios/:id url.path=/api/scenarios/webhook http.response.status_code=200
      trace
        order.place [internal] order.id=order-2 actorium.xstate.command.event=PLACE actorium.xstate.operation.outcome=completed
          · microstep orders: PLACE → {}
          · microstep order-2: SUBMIT → {"processing":{"stock":"reserving","payment":"routing"}}
          · microstep order-2: SUBMIT → {"processing":{"stock":"reserving","payment":"deferred"}}
          · microstep order-2: xstate.done.state.order.processing.payment → {"processing":{"stock":"reserving","payment":"deferred"}}
          · microstep order-2: xstate.done.actor.reserveStock → {"processing":{"stock":"reserved","payment":"deferred"}}
          · microstep order-2: xstate.done.state.order.processing.stock → {"processing":{"stock":"reserved","payment":"deferred"}}
          · microstep order-2: xstate.done.state.order.processing → {"awaitingPayment":"waiting"}
          → link POST /api/scenarios/:id
          order.reserve_stock [internal] actorium.xstate.actor.id=reserveStock
            POST inventory/reservations [client]
      trace
        payment.confirm [internal] order.id=order-2 actorium.xstate.command.event=PAYMENT_CONFIRMED actorium.xstate.operation.outcome=completed
          · microstep order-2: PAYMENT_CONFIRMED → notifying
          · microstep order-2: xstate.done.actor.notifyCustomer → placed
          · microstep orders: ORDER_CLOSED → {}
          · microstep orders: xstate.done.actor.order-2 → {}
          → link POST /api/scenarios/:id
          order.notify_customer [internal] actorium.xstate.actor.id=notifyCustomer
            POST notifications [client]
      "
    `);
  });

  test('payment declined', async () => {
    const { result, traces } = await run('payment-declined');
    expect(result).toMatchObject({ outcome: 'completed', hadError: true, state: 'declined' });
    expect(outline(traces)).toMatchInlineSnapshot(`
      "
      trace
        POST /api/scenarios/:id [server] http.request.method=POST http.route=/api/scenarios/:id url.path=/api/scenarios/payment-declined http.response.status_code=200
      trace
        order.place [internal] order.id=order-3 actorium.xstate.command.event=PLACE actorium.xstate.operation.outcome=completed actorium.xstate.operation.had_error=true actorium.xstate.operation.error_count=1
          · microstep orders: PLACE → {}
          · microstep order-3: SUBMIT → {"processing":{"stock":"reserving","payment":"routing"}}
          · microstep order-3: SUBMIT → {"processing":{"stock":"reserving","payment":"charging"}}
          · microstep order-3: xstate.done.actor.reserveStock → {"processing":{"stock":"reserved","payment":"charging"}}
          · microstep order-3: xstate.done.state.order.processing.stock → {"processing":{"stock":"reserved","payment":"charging"}}
          · microstep order-3: xstate.error.actor.chargePayment → declined
          · microstep orders: ORDER_CLOSED → {}
          · microstep orders: xstate.done.actor.order-3 → {}
          → link POST /api/scenarios/:id
          order.reserve_stock [internal] actorium.xstate.actor.id=reserveStock
            POST inventory/reservations [client]
          order.charge_payment [internal] ERROR(Payment was declined) actorium.xstate.actor.id=chargePayment
            · exception payment.failure_code=card_declined exception.type=PaymentDeclinedError exception.message=Payment was declined
            POST payments/charges [client] ERROR()
      "
    `);
  });

  test('cancel while charging', async () => {
    const { result, traces } = await run('cancel-while-charging');
    expect(result).toMatchObject({
      place: { outcome: 'cancelled', hadError: false },
      cancel: { outcome: 'completed', hadError: false },
      chargeAborted: true,
    });
    expect(outline(traces)).toMatchInlineSnapshot(`
      "
      trace
        POST /api/scenarios/:id [server] http.request.method=POST http.route=/api/scenarios/:id url.path=/api/scenarios/cancel-while-charging http.response.status_code=200
      trace
        order.cancel [internal] order.id=order-4 actorium.xstate.command.event=CANCEL actorium.xstate.operation.outcome=completed
          · microstep order-4: CANCEL → cancelled
          · microstep orders: ORDER_CLOSED → {}
          · microstep orders: xstate.done.actor.order-4 → {}
          → link POST /api/scenarios/:id
      trace
        order.place [internal] order.id=order-4 actorium.xstate.command.event=PLACE actorium.xstate.operation.outcome=cancelled
          · microstep orders: PLACE → {}
          · microstep order-4: SUBMIT → {"processing":{"stock":"reserving","payment":"routing"}}
          · microstep order-4: SUBMIT → {"processing":{"stock":"reserving","payment":"charging"}}
          · microstep order-4: xstate.done.actor.reserveStock → {"processing":{"stock":"reserved","payment":"charging"}}
          · microstep order-4: xstate.done.state.order.processing.stock → {"processing":{"stock":"reserved","payment":"charging"}}
          → link POST /api/scenarios/:id
          order.reserve_stock [internal] actorium.xstate.actor.id=reserveStock
            POST inventory/reservations [client]
          order.charge_payment [internal] actorium.xstate.actor.id=chargePayment actorium.xstate.work.outcome=cancelled
            POST payments/charges [client]
              · request.aborted
      "
    `);
  });

  test('command to a closed order', async () => {
    const { result, traces } = await run('closed-order');
    expect(result).toMatchObject({ cancel: { outcome: 'target_terminal', hadError: false } });
    expect(outline(traces)).toMatchInlineSnapshot(`
      "
      trace
        POST /api/scenarios/:id [server] http.request.method=POST http.route=/api/scenarios/:id url.path=/api/scenarios/closed-order http.response.status_code=200
      trace
        order.cancel [internal] order.id=order-5 actorium.xstate.command.event=CANCEL actorium.xstate.operation.outcome=target_terminal actorium.xstate.operation.outcome_reason=done
          → link POST /api/scenarios/:id
      trace
        order.place [internal] order.id=order-5 actorium.xstate.command.event=PLACE actorium.xstate.operation.outcome=completed
          · microstep orders: PLACE → {}
          · microstep order-5: SUBMIT → {"processing":{"stock":"reserving","payment":"routing"}}
          · microstep order-5: SUBMIT → {"processing":{"stock":"reserving","payment":"charging"}}
          · microstep order-5: xstate.done.actor.reserveStock → {"processing":{"stock":"reserved","payment":"charging"}}
          · microstep order-5: xstate.done.state.order.processing.stock → {"processing":{"stock":"reserved","payment":"charging"}}
          · microstep order-5: xstate.done.actor.chargePayment → {"processing":{"stock":"reserved","payment":"charged"}}
          · microstep order-5: xstate.done.state.order.processing.payment → {"processing":{"stock":"reserved","payment":"charged"}}
          · microstep order-5: xstate.done.state.order.processing → notifying
          · microstep order-5: xstate.done.actor.notifyCustomer → placed
          · microstep orders: ORDER_CLOSED → {}
          · microstep orders: xstate.done.actor.order-5 → {}
          → link POST /api/scenarios/:id
          order.reserve_stock [internal] actorium.xstate.actor.id=reserveStock
            POST inventory/reservations [client]
          order.charge_payment [internal] actorium.xstate.actor.id=chargePayment
            POST payments/charges [client]
          order.notify_customer [internal] actorium.xstate.actor.id=notifyCustomer
            POST notifications [client]
      "
    `);
  });

  test('reminder after a delay', async () => {
    const { result, traces } = await run('reminder');
    expect(result).toMatchObject({ state: { awaitingPayment: 'reminded' } });
    expect(outline(traces)).toMatchInlineSnapshot(`
      "
      trace
        POST /api/scenarios/:id [server] http.request.method=POST http.route=/api/scenarios/:id url.path=/api/scenarios/reminder http.response.status_code=200
      trace
        order.place [internal] order.id=order-6 actorium.xstate.command.event=PLACE actorium.xstate.operation.outcome=completed
          · microstep orders: PLACE → {}
          · microstep order-6: SUBMIT → {"processing":{"stock":"reserving","payment":"routing"}}
          · microstep order-6: SUBMIT → {"processing":{"stock":"reserving","payment":"deferred"}}
          · microstep order-6: xstate.done.state.order.processing.payment → {"processing":{"stock":"reserving","payment":"deferred"}}
          · microstep order-6: xstate.done.actor.reserveStock → {"processing":{"stock":"reserved","payment":"deferred"}}
          · microstep order-6: xstate.done.state.order.processing.stock → {"processing":{"stock":"reserved","payment":"deferred"}}
          · microstep order-6: xstate.done.state.order.processing → {"awaitingPayment":"waiting"}
          → link POST /api/scenarios/:id
          order.reserve_stock [internal] actorium.xstate.actor.id=reserveStock
            POST inventory/reservations [client]
      trace
        order.reminder [internal] actorium.xstate.scheduled.action=xstate.raise actorium.xstate.scheduled.delay_ms=50 actorium.xstate.command.event=xstate.after.reminder.order.awaitingPayment.waiting actorium.xstate.operation.outcome=completed
          · microstep order-6: xstate.after.reminder.order.awaitingPayment.waiting → {"awaitingPayment":"reminding"}
          · microstep order-6: xstate.done.actor.sendReminder → {"awaitingPayment":"reminded"}
          → link order.place
          order.notify_customer [internal] actorium.xstate.actor.id=sendReminder
            POST notifications [client]
      "
    `);
  });

  test('analytics ping', async () => {
    const { result, traces } = await run('analytics');
    expect(result).toMatchObject({
      ping: { outcome: 'completed' },
      viewed: { outcome: 'completed' },
      received: ['ping', 'checkout_viewed'],
    });
    expect(find(traces, 'analytics.send')).toHaveLength(1);
    expect(outline(traces)).toMatchInlineSnapshot(`
      "
      trace
        POST /api/scenarios/:id [server] http.request.method=POST http.route=/api/scenarios/:id url.path=/api/scenarios/analytics http.response.status_code=200
      trace
        analytics.track [internal] actorium.xstate.command.event=TRACK actorium.xstate.operation.outcome=completed
          · microstep orders: TRACK → {}
          · microstep orders: xstate.done.actor.analytics-2 → {}
          → link POST /api/scenarios/:id
          analytics.send [internal] actorium.xstate.actor.id=analytics-2
      trace
        analytics.track [internal] actorium.xstate.command.event=TRACK actorium.xstate.operation.outcome=completed
          · microstep orders: TRACK → {}
          → link POST /api/scenarios/:id
      "
    `);
  });

  test('log inside an action', async () => {
    const { result, logs: runLogs, traces } = await run('log-in-action');
    expect(result).toMatchObject({ outcome: 'completed', logCorrelated: true });
    const [operation] = find(traces, 'order.add_note');
    expect(runLogs).toEqual([expect.objectContaining({ spanId: operation!.spanId })]);
    expect(logs.at(-1)).toEqual(runLogs[0]);
    expect(outline(traces)).toMatchInlineSnapshot(`
      "
      trace
        POST /api/scenarios/:id [server] http.request.method=POST http.route=/api/scenarios/:id url.path=/api/scenarios/log-in-action http.response.status_code=200
      trace
        order.add_note [internal] order.id=order-42 actorium.xstate.command.event=ADD_NOTE actorium.xstate.operation.outcome=completed
          · log log.message=note added order.id=order-42 note.text=Leave at the back door
          · microstep orders: ADD_NOTE → {}
          → link POST /api/scenarios/:id
      "
    `);
  });

  test('custom namespace', async () => {
    const { result, traces } = await run('custom-namespace');
    expect(result).toMatchObject({ outcome: 'completed', hadError: false });
    const [operation] = find(traces, 'order.place');
    const keys = Object.keys(operation!.attributes).filter((key) => key !== 'order.id');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toMatch(/^shop\.orders\./);
    expect(outline(traces)).toMatchInlineSnapshot(`
      "
      trace
        POST /api/scenarios/:id [server] http.request.method=POST http.route=/api/scenarios/:id url.path=/api/scenarios/custom-namespace http.response.status_code=200
      trace
        order.place [internal] order.id=shop-order-1 shop.orders.command.event=PLACE shop.orders.operation.outcome=completed
          → link POST /api/scenarios/:id
          order.reserve_stock [internal] shop.orders.actor.id=reserveStock
            POST inventory/reservations [client]
          order.charge_payment [internal] shop.orders.actor.id=chargePayment
            POST payments/charges [client]
          order.notify_customer [internal] shop.orders.actor.id=notifyCustomer
            POST notifications [client]
      "
    `);
  });

  test('concurrent requests keep their own logs', async () => {
    // The note is logged while the reminder request is still waiting.
    const [reminder, note] = await Promise.all([run('reminder'), run('log-in-action')]);
    expect(reminder.logs).toEqual([]);
    expect(note.result).toMatchObject({ logCorrelated: true });
    const [operation] = find(note.traces, 'order.add_note');
    expect(note.logs).toEqual([expect.objectContaining({ spanId: operation!.spanId })]);
  });

  test('every scenario is covered', () => {
    expect(scenarios.map(({ id }) => id)).toEqual([
      'place-order',
      'webhook',
      'payment-declined',
      'cancel-while-charging',
      'closed-order',
      'reminder',
      'analytics',
      'log-in-action',
      'custom-namespace',
    ]);
  });
});
