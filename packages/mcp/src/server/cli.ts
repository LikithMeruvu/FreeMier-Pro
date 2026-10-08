#!/usr/bin/env node
import { startStdio } from './server.js';

const workspace = process.env.FREEMIER_WORKSPACE;
const bridgePort = process.env.FREEMIER_BRIDGE_PORT
  ? Number(process.env.FREEMIER_BRIDGE_PORT)
  : undefined;

startStdio({
  ...(workspace ? { workspace } : {}),
  ...(Number.isFinite(bridgePort) ? { bridgePort } : {}),
}).catch((err) => {
  process.stderr.write(`[freemier-pro] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
