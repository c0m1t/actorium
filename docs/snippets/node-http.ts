import { createServer } from 'node:http';
import { orders } from './app.js';
import { tracing } from './tracing.js';

// Actors live in a registry outside request handlers; one owner per workflow.
createServer((request, response) => {
  const orderId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('order');
  const actor = orderId ? orders.get(orderId) : undefined;
  if (!actor) {
    response.writeHead(404).end();
    return;
  }
  const command = tracing.sendCommand(actor, { type: 'SUBMIT' }, { name: 'order.submit' });
  response.writeHead(202, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ traceId: command.traceId }));
}).listen(3000);
