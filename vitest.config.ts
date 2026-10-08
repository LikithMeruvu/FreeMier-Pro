import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    // Native render tests start FFmpeg processes; run files sequentially so
    // low-core machines do not launch many encoder worker pools at once.
    fileParallelism: false,
    maxWorkers: 2,
  },
});
