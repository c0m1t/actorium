import { orders, waitForOrderReply } from './app.js';
import { tracing } from './tracing.js';

// The request waits for a business reply: the operation is a child span.
export async function priceOrder(orderId: string): Promise<Response> {
  const actor = orders.get(orderId);
  if (!actor) return new Response(null, { status: 404 });
  const reply = waitForOrderReply(orderId); // the application's result channel
  const command = tracing.sendCommand(
    actor,
    { type: 'PRICE' },
    { name: 'order.price', relationship: 'child' },
  );
  const body = await reply;
  await command.finished; // optional: telemetry settled as well
  return Response.json(body);
}
