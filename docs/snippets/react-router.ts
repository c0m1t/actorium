import { orders } from './app.js';
import { tracing } from './tracing.js';

// React Router's generated `Route.ActionArgs`, reduced to what this uses.
interface ActionArgs {
  request: Request;
  params: { orderId?: string };
}

export async function action({ request, params }: ActionArgs): Promise<Response> {
  const actor = params.orderId ? orders.get(params.orderId) : undefined;
  if (!actor) return new Response(null, { status: 404 });
  // The HTTP server span is active here when the SDK started first.
  const command = tracing.sendCommand(
    actor,
    { type: 'SUBMIT', payload: await request.json() },
    { name: 'order.submit' },
  );
  return Response.json({ accepted: true, traceId: command.traceId }, { status: 202 });
}
