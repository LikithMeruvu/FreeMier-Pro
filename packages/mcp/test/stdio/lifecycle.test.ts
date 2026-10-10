import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EditorStore } from '@freemier/engine';
import { createServer } from '../../src/server/server.js';
import { promises as fs } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
let workspace: string, child: ChildProcess | undefined;
const adapters: ReturnType<typeof createServer>[] = [];
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-mcp-lifecycle-')); });
afterEach(async () => {
  for (const adapter of adapters.splice(0)) { await adapter.server.close(); adapter.dispose(); }
  if (child?.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
  child = undefined;
  expect(path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('MCP owning-session lifecycle', () => {
  it.each([false, true])('adapter close disposes an owned session but preserves a borrowed store (borrowed=%s)', async borrowed => {
    const adapter = createServer({ workspace, ...(borrowed ? { store: EditorStore.create() } : {}) });
    adapters.push(adapter);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await adapter.server.connect(serverTransport);
    const client = new Client({ name: 'lifecycle-check', version: '1' }); await client.connect(clientTransport);
    const owner = adapter.context.projectProtection!; await owner.ready;
    expect((await client.listTools()).tools).toHaveLength(102);
    await client.close();
    if (borrowed) expect(await owner.configure({ enabled: false })).toMatchObject({ enabled: false });
    else await expect(owner.configure({ enabled: false })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it.each(['ready', 'during startup'])('ends the real owner on harness EOF %s without a termination signal', async timing => {
    child = spawn(process.execPath, [path.join(repository, 'packages/mcp/dist/cli.js')], {
      env: { ...process.env, FREEMIER_WORKSPACE: workspace, FREEMIER_BRIDGE_PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let diagnostic = '', port = 0;
    const exited = once(child, 'exit');
    if (timing === 'during startup') child.stdin!.end();
    if (timing === 'ready') await new Promise<void>((resolve, reject) => {
      child!.stderr!.on('data', data => {
        diagnostic += data.toString();
        const matched = /live bridge on http:\/\/127\.0\.0\.1:(\d+)/.exec(diagnostic);
        if (matched) port = Number(matched[1]);
        if (port && diagnostic.includes('ready on stdio')) resolve();
      });
      child!.once('error', reject);
      child!.once('exit', code => reject(new Error(`Owner exited before ready (${code}): ${diagnostic}`)));
    });
    if (timing === 'ready') {
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
      child.stdin!.end();
    }
    const [code, signal] = await exited;
    expect(code, diagnostic).toBe(0); expect(signal).toBeNull();
    if (port) await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  }, 15000);
});
