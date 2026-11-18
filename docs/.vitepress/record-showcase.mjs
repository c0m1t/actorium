import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pnpm } from '../../scripts/workspace.mjs';

const pageFile = new URL('../public/xstate-otel/showcase/index.html', import.meta.url);
pnpm(fileURLToPath(new URL('../', import.meta.url)), [
  '--filter',
  '@actorium/xstate-otel-showcase',
  'run',
  'record',
  fileURLToPath(pageFile),
]);

// Both views use the same recording and source snippets. Keep the payload out
// of VitePress's page/preload bundles; the viewer fetches it after mounting.
const page = readFileSync(pageFile, 'utf8');
function embeddedData(id) {
  const match = new RegExp(`<script type="application/json" id="${id}">(.*?)</script>`).exec(page);
  if (!match) throw new Error(`Missing ${id} in the recorded showcase`);
  return JSON.parse(match[1]);
}
const dataFile = new URL('./generated/showcase.json', import.meta.url);
mkdirSync(new URL('.', dataFile), { recursive: true });
const payload = JSON.stringify({
  recordings: embeddedData('showcase-recordings'),
  sources: embeddedData('showcase-sources'),
});
const hash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
const name = `recordings.${hash}.json`;
const publicDirectory = new URL('.', pageFile);
writeFileSync(new URL(name, publicDirectory), payload);
writeFileSync(dataFile, JSON.stringify({ recordingUrl: `/xstate-otel/showcase/${name}` }));
for (const old of readdirSync(publicDirectory)) {
  if (/^recordings\.[a-f0-9]{16}\.json$/.test(old) && old !== name) {
    rmSync(new URL(old, publicDirectory));
  }
}
