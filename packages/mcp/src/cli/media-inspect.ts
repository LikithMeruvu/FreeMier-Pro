#!/usr/bin/env node
import { probeMedia } from '@freemier/media';
import { serializeError } from '@freemier/shared';

const [, , area, action, file] = process.argv;
if (area !== 'media' || action !== 'inspect' || !file) {
  process.stderr.write('Usage: palmier media inspect <file>\n');
  process.exitCode = 1;
} else {
  try { process.stdout.write(`${JSON.stringify(await probeMedia(file), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify(serializeError(error))}\n`); process.exitCode = 1; }
}
