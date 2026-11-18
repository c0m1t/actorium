import { afterEach, beforeEach, expect } from 'vitest';

const methods = ['debug', 'dir', 'error', 'info', 'log', 'table', 'trace', 'warn'] as const;
const unexpected = new Map<string, number>();
const restore: (() => void)[] = [];

beforeEach(() => {
  unexpected.clear();
  for (const method of methods) {
    const original = console[method];
    // Plain wrappers allow individual tests to spy on and assert expected output.
    // Retain counts only, so a failure cannot dump large event payloads again.
    console[method] = () => {
      unexpected.set(method, (unexpected.get(method) ?? 0) + 1);
    };
    restore.push(() => {
      console[method] = original;
    });
  }
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  expect(
    Object.fromEntries(unexpected),
    'Unexpected console output; capture and assert intentional diagnostics within the test',
  ).toEqual({});
});
