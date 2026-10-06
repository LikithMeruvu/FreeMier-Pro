import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EditorStore } from '@freemier/engine';
import { z } from 'zod';
import { TOOLS } from './tools.js';
import { extractThumbnail, extractWaveform, exportProject, importMedia } from '@freemier/ffmpeg';
import { EditorError } from '@freemier/shared';

/**
 * Live-sync bridge.
 *
 * The MCP server and the GUI share ONE EditorStore. This bridge exposes that
 * store over loopback HTTP so the Electron renderer can:
 *   GET /state   -> the full current project (initial paint)
 *   GET /events  -> Server-Sent Events stream of every change (live updates)
 *
 * This is what makes "watch the agent edit" work: an MCP tool call mutates the
 * store, which pushes an SSE event, which the renderer applies — no reload.
 *
 * Bound to 127.0.0.1 only. Never exposed off-host.
 */

export interface BridgeOptions {
  store: EditorStore;
  port?: number;
  /** Directory used for thumbnails, waveforms, and exports. */
  workspace: string;
}

interface SseClient {
  id: number;
  res: ServerResponse;
}

export class LiveBridge {
  readonly #store: EditorStore;
  readonly #workspace: string;
  readonly #clients = new Set<SseClient>();
  #server: HttpServer | null = null;
  #nextClientId = 1;
  #port: number;
  #unsubscribe: (() => void) | null = null;
  #thumbnails = new Map<string, Promise<string>>();
  #waveforms = new Map<string, Promise<number[]>>();

  constructor(opts: BridgeOptions) {
    this.#store = opts.store;
    this.#workspace = opts.workspace;
    this.#port = opts.port ?? 4317;
  }

  get port(): number {
    return this.#port;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** Start listening. Resolves once bound. Pass port 0 for an ephemeral port. */
  async start(): Promise<number> {
    const server = createServer((req, res) => this.#handle(req, res));
    this.#server = server;

    // Push every store change to all connected renderers.
    this.#unsubscribe = this.#store.subscribe((event) => {
      this.#broadcast({
        type: 'change',
        revision: event.revision,
        kind: event.kind,
        ids: event.ids,
        state: event.state,
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#port, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (address && typeof address === 'object') this.#port = address.port;
    return this.#port;
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const client of this.#clients) {
      try { client.res.end(); } catch { /* already closed */ }
    }
    this.#clients.clear();
    if (this.#server) {
      await new Promise<void>((resolve) => this.#server!.close(() => resolve()));
      this.#server = null;
    }
  }

  #broadcast(payload: unknown): void {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.#clients) {
      try {
        client.res.write(frame);
      } catch {
        this.#clients.delete(client);
      }
    }
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  }

  /** Read and parse a JSON request body, bounded to 1 MB. */
  static async #readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > 1024 * 1024) throw new EditorError('INVALID_ARGUMENT', 'Request body too large');
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new EditorError('INVALID_ARGUMENT', 'Request body is not valid JSON');
    }
  }

  /**
   * Apply an edit requested by the GUI.
   * The GUI edits the same store the agent edits, so both see one timeline.
   */
  async #handleCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await LiveBridge.#readBody(req);
      const aliases: Record<string, string> = { clip_transform: 'clip_set_transform', clip_audio: 'clip_set_audio' };
      const action = aliases[String(body.action ?? '')] ?? String(body.action ?? '');
      const tool = TOOLS.find((t) => t.name === action);
      if (!tool || ['project_load', 'project_create', 'export_video'].includes(action)) throw new EditorError('INVALID_ARGUMENT', 'Unknown bridge command', { action });
      const parsed = z.object(tool.inputSchema).safeParse(body);
      if (!parsed.success) throw new EditorError('INVALID_ARGUMENT', 'Invalid command arguments', { issues: parsed.error.issues });
      const result = await tool.handler(parsed.data, { store: this.#store, workspace: this.#workspace, notify: () => {} });
      this.#json(res, 200, result);
    } catch (err) {
      const e = err as EditorError;
      this.#json(res, 400, {
        ok: false,
        error: { code: e.code ?? 'INTERNAL', message: e.message ?? String(err), details: e.details },
      });
    }
  }

  /** Render a thumbnail for a media path so the bin can show a poster frame. */
  async #handleAsset(req: IncomingMessage, res: ServerResponse, waveform: boolean): Promise<void> {
    try {
      const body = await LiveBridge.#readBody(req);
      const asset = this.#store.project.media.find((m) => m.id === body.assetId);
      if (!asset) throw new EditorError('NOT_FOUND', 'Media asset not found');
      const source = asset.copied ? path.join(this.#workspace, 'media', asset.path) : asset.path;
      if (waveform) {
        if (!this.#waveforms.has(asset.id)) this.#waveforms.set(asset.id, asset.hasAudio ? extractWaveform(source, 600) : Promise.resolve([]));
        this.#json(res, 200, { ok: true, peaks: await this.#waveforms.get(asset.id) });
      } else {
        if (!this.#thumbnails.has(asset.id)) this.#thumbnails.set(asset.id, (async () => {
          const out = path.join(this.#workspace, 'cache', `thumb-${asset.id}.jpg`);
          await extractThumbnail(source, out, .5, 160, asset.duration);
          return `data:image/jpeg;base64,${(await fs.readFile(out)).toString('base64')}`;
        })());
        this.#json(res, 200, { ok: true, dataUrl: await this.#thumbnails.get(asset.id) });
      }
    } catch (err) {
      const e = err as EditorError;
      this.#json(res, 400, { ok: false, error: { code: e.code ?? 'PROBE_ERROR', message: e.message ?? String(err) } });
    }
  }

  async #handleExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await LiveBridge.#readBody(req);
      const out = String(body.outputPath ?? `${this.#workspace}/export-${Date.now()}.mp4`);
      this.#broadcast({ type: 'export-progress', outputPath: out, fraction: 0 });
      const result = await exportProject(this.#store.project, {
        outputPath: out,
        mediaDirectory: path.join(this.#workspace, 'media'),
        codec: body.codec as 'h264' | 'h265' | 'prores' | undefined,
        crf: typeof body.crf === 'number' ? body.crf : undefined,
        onProgress: (fraction) => this.#broadcast({ type: 'export-progress', outputPath: out, fraction }),
      });
      this.#json(res, 200, { ok: true, ...result });
    } catch (err) {
      const e = err as EditorError;
      this.#json(res, 500, {
        ok: false,
        error: { code: e.code ?? 'EXPORT_ERROR', message: e.message ?? String(err), details: e.details },
      });
    }
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    // Loopback only — defence in depth in case the bind address is changed.
    const remote = req.socket.remoteAddress ?? '';
    if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
      this.#json(res, 403, { error: 'loopback only' });
      return;
    }

    // Electron's file renderer has origin "null"; permit local development too.
    // Do not grant arbitrary websites access to this editing/file-access API.
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
      this.#json(res, 403, { error: 'local renderer only' });
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname;

    if (route === '/state') {
      this.#json(res, 200, {
        project: this.#store.project,
        revision: this.#store.revision,
        canUndo: this.#store.canUndo,
        canRedo: this.#store.canRedo,
      });
      return;
    }

    if (route === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1000\n\n');

      const client: SseClient = { id: this.#nextClientId++, res };
      this.#clients.add(client);

      // Send current state immediately so a late subscriber is never stale.
      res.write(`data: ${JSON.stringify({
        type: 'snapshot',
        revision: this.#store.revision,
        state: { project: this.#store.project, revision: this.#store.revision },
      })}\n\n`);

      // Keepalive so proxies and the browser do not drop an idle stream.
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* closed */ }
      }, 15000);

      req.on('close', () => {
        clearInterval(heartbeat);
        this.#clients.delete(client);
      });
      return;
    }

    if (route === '/health') {
      this.#json(res, 200, { ok: true, app: 'freemier-pro', workspace: this.#workspace, clients: this.#clients.size, revision: this.#store.revision });
      return;
    }

    if (route === '/command' && req.method === 'POST') {
      void this.#handleCommand(req, res);
      return;
    }

    if (route === '/export' && req.method === 'POST') {
      void this.#handleExport(req, res);
      return;
    }
    if ((route === '/thumbnail' || route === '/waveform') && req.method === 'POST') {
      void this.#handleAsset(req, res, route === '/waveform');
      return;
    }

    this.#json(res, 404, {
      error: 'not found',
      routes: ['/state', '/events', '/health', '/command', '/export', '/thumbnail', '/waveform'],
    });
  }
}
