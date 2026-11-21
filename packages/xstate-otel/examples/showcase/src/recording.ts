import type { AddressInfo } from 'node:net';
import { scenarios } from './scenarios.ts';
import { createShowcaseServer } from './server.ts';
import { createShowcase } from './showcase.ts';
import { startTelemetry } from './telemetry.ts';

/** Runs the live HTTP scenarios and embeds their responses in the shared viewer. */
export async function createRecordedShowcasePage(): Promise<string> {
  // Documentation builds never export spans to an external collector.
  const telemetry = startTelemetry({});
  const showcase = createShowcase({ tracer: telemetry.tracer, log: () => {} });
  const server = createShowcaseServer(telemetry, showcase);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const recordings = [];
    for (const { id, title, shows } of scenarios) {
      const response = await fetch(`${base}/api/scenarios/${id}`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Showcase scenario ${id} failed: ${response.status}`);
      recordings.push({ id, title, shows, run: await response.json() });
    }
    const page = await (await fetch(base)).text();
    // Keep embedded JSON from terminating its script element.
    const data = JSON.stringify(recordings).replaceAll('<', '\\u003c');
    return page.replace(
      '<!-- showcase-recordings -->',
      `<script type="application/json" id="showcase-recordings">${data}</script>`,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    showcase.stop();
    await showcase.waitForBookkeeping();
    await telemetry.shutdown();
  }
}
