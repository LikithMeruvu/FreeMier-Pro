import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../packages/ffmpeg/fonts/', import.meta.url));
const target = fileURLToPath(new URL('../packages/gui/dist/fonts/', import.meta.url));
await fs.mkdir(target, { recursive: true });
for (const file of ['NotoSans-Regular.ttf', 'OFL.txt', 'README.md']) await fs.copyFile(source + file, target + file);
