import { EditorStore } from '@freemier/engine';
import { createSession } from '@freemier/service';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../tools/call.js';
import { listTools } from '../tools/list.js';

/**
 * MCP server.
 *
 * Runs headless — it has no Electron dependency and never will. The GUI embeds
 * the same engine in-process; this server is the independent path that lets an
 * agent edit video with no UI open at all.
 */

export interface ServerOptions {
  /** Directory for project files, exports, and caches. */
  workspace?: string;
  /**
   * Called on every change. The GUI uses this to update live; a headless
   * run leaves it undefined.
   */
  onChange?: (event: { kind: string; ids: string[]; revision: number }) => void;
  /**
   * Use an existing store instead of creating a private one.
   *
   * This is what lets the GUI share one timeline with an agent: pass the
   * store the GUI already renders and MCP edits land in the same state.
   * Omitting it creates a private store (the headless case).
   */
  store?: EditorStore;
  /**
   * When set, also host the live bridge on this loopback port, sharing this
   * server's store. The GUI attaches to it as a viewer, so agent edits made
   * through MCP appear in the GUI in real time.
   */
  bridgePort?: number;
}

export function createServer(options: ServerOptions = {}) {
  const { store, context, dispose } = createSession(options);

  const server = new Server(
    { name: 'freemier-pro', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );


  server.setRequestHandler(ListToolsRequestSchema, listTools);

  server.setRequestHandler(CallToolRequestSchema, request => callTool(request, context));

  // Closing a borrowed adapter must not dispose another owner's editing session.
  server.onclose = () => { if (!options.store) dispose(); };
  return { server, store, context, dispose };
}

/** Start the server on stdio, optionally hosting the GUI's live bridge. */
export async function startStdio(options: ServerOptions = {}): Promise<{ port: number | null; dispose: () => Promise<void> }> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(options.workspace ?? path.join(os.homedir(), '.freemier'), { recursive: true });
  const { server, store, context, dispose } = createServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let port: number | null = null;
  let bridge: import('@freemier/service').LiveBridge | undefined;
  let bridgeStart: Promise<number> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = Promise.resolve().then(async () => {
      process.off('SIGINT', signalShutdown);
      process.off('SIGTERM', signalShutdown);
      process.stdin.off('end', signalShutdown);
      process.stdin.off('close', signalShutdown);
      if (!options.store) dispose();
      // EOF can arrive while preferences are loading and before listen binds.
      // Settle that startup before stopping its server, so it cannot bind later.
      await bridgeStart?.catch(() => undefined);
      await Promise.all([bridge?.stop(), server.close()]);
    });
    return shutdownPromise;
  };
  const signalShutdown = () => {
    void shutdown().catch(error => process.stderr.write(`[freemier-pro] shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`));
  };
  const closed = server.onclose;
  server.onclose = () => { closed?.(); signalShutdown(); };
  process.on('SIGINT', signalShutdown);
  process.on('SIGTERM', signalShutdown);
  process.stdin.once('end', signalShutdown);
  process.stdin.once('close', signalShutdown);
  if (typeof options.bridgePort === 'number') {
    const { LiveBridge } = await import('@freemier/service');
    bridge = new LiveBridge({
      store,
      port: options.bridgePort,
      workspace: context.workspace,
    });
    bridgeStart = bridge.start();
    try { port = await bridgeStart; }
    catch (error) { await shutdown(); throw error; }
    if (shutdownPromise) { await shutdownPromise; return { port: null, dispose: shutdown }; }
    process.stderr.write(`[freemier-pro] live bridge on http://127.0.0.1:${port}\n`);

  }

  process.stderr.write('[freemier-pro] ready on stdio\n');
  return { port, dispose: shutdown };
}
