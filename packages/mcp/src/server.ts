import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { EditorStore } from '@freemier/engine';
import { serializeError, EditorError } from '@freemier/shared';
import { TOOLS, type ToolContext } from './tools.js';
import os from 'node:os';
import path from 'node:path';

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
  const workspace = options.workspace ?? path.join(os.homedir(), '.freemier');
  const store = options.store ?? EditorStore.create({ name: 'Untitled Project' });

  const server = new Server(
    { name: 'freemier-pro', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const context: ToolContext = {
    store,
    workspace,
    notify: (event) => {
      options.onChange?.({ ...event, revision: store.revision });
    },
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: zodToJsonSchema(z.object(t.inputSchema), {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      }) as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = TOOLS.find((t) => t.name === name);

    if (!tool) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: { code: 'NOT_FOUND', message: `Unknown tool: ${name}`, details: { available: TOOLS.map((t) => t.name) } },
          }),
        }],
      };
    }

    const parsed = z.object(tool.inputSchema).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: {
              code: 'INVALID_ARGUMENT',
              message: `Invalid arguments for ${name}`,
              details: { issues: parsed.error.issues },
            },
          }),
        }],
      };
    }

    try {
      const result = await tool.handler(parsed.data as Record<string, unknown>, context);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // Never leak a stack trace across the boundary — agents act on codes.
      const serialized = serializeError(err);
      if (!(err instanceof EditorError)) {
        process.stderr.write(`[freemier-pro] ${name} failed: ${serialized.message}\n`);
      }
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: serialized }) }],
      };
    }
  });

  return { server, store, context };
}

/** Start the server on stdio, optionally hosting the GUI's live bridge. */
export async function startStdio(options: ServerOptions = {}): Promise<{ port: number | null }> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(options.workspace ?? path.join(os.homedir(), '.freemier'), { recursive: true });
  const { server, store } = createServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let port: number | null = null;
  if (typeof options.bridgePort === 'number') {
    const { LiveBridge } = await import('./bridge.js');
    const bridge = new LiveBridge({
      store,
      port: options.bridgePort,
      workspace: options.workspace ?? process.cwd(),
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
