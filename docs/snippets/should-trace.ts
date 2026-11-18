import { products } from './app.js';
import { tracing } from './tracing.js';

// Both children run; only `required` gets a span and keeps the command open.
export const loadProduct = tracing.fromPromise<{ label: string }, { sku: string }>(
  'product.load',
  async ({ input, signal }) => products.load(input.sku, { signal }),
  { shouldTrace: ({ self }) => self.id !== 'prefetch' },
);

// A parent-state policy: skip work started while the parent is tagged `background`.
export const refreshProduct = tracing.fromPromise<{ label: string }, { sku: string }>(
  'product.refresh',
  async ({ input, signal }) => products.load(input.sku, { signal }),
  { shouldTrace: ({ parent }) => !parent?.getSnapshot().hasTag('background') },
);
