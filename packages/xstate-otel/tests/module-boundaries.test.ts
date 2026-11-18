import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// The lifecycle core must stay backend-neutral so another telemetry backend
// can reuse it. OpenTelemetry is imported only by the backend and public types.

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function imports(): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const file of await readdir(sourceRoot, { recursive: true })) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(join(sourceRoot, file), 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'/g)].map(
      (match) => (match[1] ?? match[2])!,
    );
    result.set(file.replaceAll('\\', '/'), specifiers);
  }
  return result;
}

it('imports OpenTelemetry only from the backend and public types', async () => {
  const offenders = [...(await imports())]
    .filter(([file]) => !file.startsWith('otel/') && file !== 'types.ts')
    .filter(([, specifiers]) => specifiers.some((s) => s.startsWith('@opentelemetry/')))
    .map(([file]) => file);
  expect(offenders).toEqual([]);
});

it('keeps core and XState adapters independent of the backend', async () => {
  const offenders = [...(await imports())]
    .filter(([file]) => file.startsWith('core/') || file.startsWith('xstate/'))
    .flatMap(([file, specifiers]) =>
      specifiers
        .filter((s) => s.includes('/otel/') || s === '../types.js' || s === '../index.js')
        .map((s) => `${file} -> ${s}`),
    );
  expect(offenders).toEqual([]);
});

it('keeps the XState adapters free of runtime state', async () => {
  const offenders = [...(await imports())]
    .filter(([file]) => file.startsWith('xstate/'))
    .flatMap(([file, specifiers]) =>
      specifiers.filter((s) => s.startsWith('.')).map((s) => `${file} -> ${s}`),
    );
  expect(offenders).toEqual([]);
});
