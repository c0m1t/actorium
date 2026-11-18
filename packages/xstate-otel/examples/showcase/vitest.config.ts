import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against the library source, so `test` needs no build.
    alias: {
      '@actorium/xstate-otel': fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
    },
  },
});
