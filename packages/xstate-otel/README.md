# @actorium/xstate-otel

OpenTelemetry tracing for long-lived XState v5 actor systems.

An actor that lives for days should not be one span. This library gives each
command its own bounded trace: an operation span that follows the deliveries,
actor relays and Promise work the command causes, and ends when that work
settles. Trace context never enters machine context, events or inputs.

## Install

```sh
npm install @actorium/xstate-otel xstate @opentelemetry/api
```

Peer dependencies: `xstate` `>=5.33.0 <6` and `@opentelemetry/api`
`>=1.9.0 <2`. Requires Node.js 24 or later. Your application owns the
OpenTelemetry SDK and exporter.

## Example

```ts
import { trace } from '@opentelemetry/api';
import { createXStateTracing } from '@actorium/xstate-otel';
import { createActor, setup } from 'xstate';

const tracing = createXStateTracing({ tracer: trace.getTracer('orders') });

// Finite Promise work becomes a child span of the command that started it.
const charge = tracing.fromPromise<string, { orderId: string }>(
  'payment.charge',
  async ({ input, signal }) => {
    const response = await fetch(`https://payments.example/orders/${input.orderId}/charge`, {
      method: 'POST',
      signal,
    });
    return response.text();
  },
);

const order = setup({
  types: { events: {} as { type: 'PAY'; orderId: string } },
  actors: { charge },
}).createMachine({
  initial: 'open',
  states: {
    open: { on: { PAY: 'charging' } },
    charging: {
      invoke: { src: 'charge', input: ({ event }) => ({ orderId: event.orderId }) },
    },
  },
});

const actor = createActor(order, { inspect: tracing.inspect }).start();
const command = tracing.sendCommand(actor, { type: 'PAY', orderId: 'o-1' }, { name: 'order.pay' });
await command.finished; // { outcome: 'completed', hadError: false }
```

## Documentation

Guides, recipes and the API reference are at
[c0m1t.github.io/actorium](https://c0m1t.github.io/actorium/), starting with
[getting started](https://c0m1t.github.io/actorium/xstate-otel/guide/getting-started).

## License

[MIT](LICENSE)
