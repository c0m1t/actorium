import { orders } from './app.js';
import { tracing } from './tracing.js';

// Accept work and answer before it finishes: a linked trace (the default).
export async function submitOrder(request: Request, orderId: string): Promise<Response> {
  const actor = orders.get(orderId);
  if (!actor) return new Response(null, { status: 404 });
  const command = tracing.sendCommand(
    actor,
    { type: 'SUBMIT', payload: await request.json() },
    { name: 'order.submit', attributes: { 'order.id': orderId } },
  );
  return Response.json({ accepted: true, traceId: command.traceId }, { status: 202 });
}
