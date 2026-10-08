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
  const { store, context } = createSession(options);

  const server = new Server(
    { name: 'freemier-pro', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );


  server.setRequestHandler(ListToolsRequestSchema, listTools);

  server.setRequestHandler(CallToolRequestSchema, request => callTool(request, context));

  return { server, store, context };
}

/** Start the server on stdio, optionally hosting the GUI's live bridge. */
export async function startStdio(options: ServerOptions = {}): Promise<{ port: number | null }> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(options.workspace ?? path.join(os.homedir(), '.freemier'), { recursive: true });
  const { server, store, context } = createServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let port: number | null = null;
  if (typeof options.bridgePort === 'number') {
    const { LiveBridge } = await import('@freemier/service');
    const bridge = new LiveBridge({
      store,
      port: options.bridgePort,
      workspace: context.workspace,
    });
    port = await bridge.start();
    process.stderr.write(`[freemier-pro] live bridge on http://127.0.0.1:${port}\n`);

    const shutdown = () => { void bridge.stop(); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  process.stderr.write('[freemier-pro] ready on stdio\n');
  return { port };
}
