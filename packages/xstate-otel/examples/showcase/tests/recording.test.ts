import { readFileSync } from 'node:fs';
import { beforeAll, expect, test } from 'vitest';
import { createRecordedShowcasePage } from '../src/recording.ts';
import { scenarios } from '../src/scenarios.ts';
import type { TraceView } from '../src/trace-tree.ts';

interface Snippet {
  file: string;
  line: number;
  code: string;
  html: string;
  href?: string;
}

interface Sources {
  context: Snippet;
  scenarios: Record<string, Snippet>;
  machine: Snippet[];
  tracing: Snippet[];
}

let page: string;

// Allow all nine 15 s request budgets plus setup and cleanup. Request aborts
// should report failures before the shared fixture's own timeout.
beforeAll(async () => {
  page = await createRecordedShowcasePage();
}, 180_000);

function embeddedData<T>(id: string): T {
  const embedded = new RegExp(`<script type="application/json" id="${id}">(.*?)</script>`).exec(
    page,
  );
  expect(embedded).not.toBeNull();
  return JSON.parse(embedded![1]!) as T;
}

test('records every real HTTP scenario in a standalone viewer', () => {
  const recordings = embeddedData<
    {
      id: string;
      run: { traces: TraceView[]; result: Record<string, unknown>; error?: string };
    }[]
  >('showcase-recordings');
  expect(recordings.map(({ id }) => id)).toEqual(scenarios.map(({ id }) => id));
  for (const { id, run } of recordings) {
    expect(run.error, id).toBeUndefined();
    const request = run.traces[0]!.roots[0]!;
    expect(request.kind, id).toBe('server');
    expect(request.attributes['url.path'], id).toBe(`/api/scenarios/${id}`);
    expect(request.attributes['http.response.status_code'], id).toBe(200);
  }
  expect(recordings.find(({ id }) => id === 'cancel-while-charging')!.run.result).toMatchObject({
    chargeAborted: true,
  });
  expect(recordings.find(({ id }) => id === 'reminder')!.run.traces.length).toBeGreaterThan(1);
});

test('embeds the matching scenario and shared source files', () => {
  const sources = embeddedData<Sources>('showcase-sources');
  expect(Object.keys(sources.scenarios)).toEqual(scenarios.map(({ id }) => id));
  expect(sources.context.code).toContain('const tea =');
  for (const { id } of scenarios) {
    const snippet = sources.scenarios[id]!;
    expect(snippet.code, id).toContain(`id: '${id}'`);
    expect(snippet.code, id).toContain('async run(');
    expect(snippet.line, id).toBeGreaterThan(1);
  }
  expect(sources.machine.map(({ file }) => file)).toEqual(['src/desk.ts']);
  expect(sources.tracing.map(({ file }) => file)).toEqual(['src/showcase.ts', 'src/telemetry.ts']);
  for (const snippet of [...sources.machine, ...sources.tracing]) {
    expect(snippet.code).toBe(readFileSync(new URL(`../${snippet.file}`, import.meta.url), 'utf8'));
  }
});

test('highlights source code without changing its displayed text or introducing markup', () => {
  const sources = embeddedData<Sources>('showcase-sources');
  for (const snippet of [
    sources.context,
    ...Object.values(sources.scenarios),
    ...sources.machine,
    ...sources.tracing,
  ]) {
    expect(snippet.html).toContain('<span class="syntax-');
    const displayed = snippet.html
      .replace(/<\/?span[^>]*>/g, '')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
    expect(displayed).toBe(snippet.code);
    expect(snippet.html).not.toMatch(/<(?!\/?span\b)/);
  }
});
