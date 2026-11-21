import { createShowcase } from './showcase.ts';
import { createShowcaseServer } from './server.ts';
import { startTelemetry } from './telemetry.ts';

// Start the SDK before the actors, as a host application would.
const telemetry = startTelemetry();
const showcase = createShowcase({ tracer: telemetry.tracer });
const server = createShowcaseServer(telemetry, showcase);
const port = Number(process.env['PORT'] ?? 3000);

server.listen(port, () => {
  console.log(`xstate-otel showcase on http://localhost:${port}`);
  if (process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) {
    console.log(`Exporting spans to ${process.env['OTEL_EXPORTER_OTLP_ENDPOINT']}`);
  }
});

// Stop ingress and actors, drain tracing bookkeeping, then flush the SDK.
const shutdown = async (): Promise<void> => {
  server.close();
  showcase.stop();
  await showcase.waitForBookkeeping();
  await telemetry.shutdown();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
