import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
  },
});
