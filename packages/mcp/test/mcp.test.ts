import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end MCP tests.
 *
 * These drive the REAL server over stdio using the real MCP protocol —
 * no mocks, no in-process shortcuts. If this passes, an agent can use it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../dist/cli.js');
const FIXTURES = path.resolve(here, '../../../fixtures/media');

interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Minimal MCP stdio client. */
class McpClient {
  #child: ChildProcess;
  #buffer = '';
  #pending = new Map<number, (r: RpcResponse) => void>();
  #nextId = 1;

  constructor(workspace: string) {
    this.#child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, FREEMIER_WORKSPACE: workspace },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child.stdout!.on('data', (chunk: Buffer) => this.#onData(chunk));
  }

  #onData(chunk: Buffer): void {
    this.#buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as RpcResponse;
        const resolve = this.#pending.get(msg.id);
        if (resolve) {
          this.#pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // Ignore non-JSON banner lines.
      }
    }
  }

  request(method: string, params: unknown = {}): Promise<RpcResponse> {
    const id = this.#nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, 60000);
      this.#pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      this.#child.stdin!.write(`${payload}\n`);
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.#child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1' },
    });
    this.notify('notifications/initialized');
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) throw new Error(`RPC error: ${res.error.message}`);
    const result = res.result as { content?: Array<{ text?: string }>; isError?: boolean };
    const text = result.content?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (result.isError) {
      const err = parsed.error as { code?: string; message?: string } | undefined;
      const e = new Error(err?.message ?? 'tool error') as Error & { code?: string };
      e.code = err?.code;
      throw e;
    }
    return parsed;
  }

  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
    const res = await this.request('tools/list');
    return (res.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools;
  }

  kill(): void {
    this.#child.kill();
  }
}

let workspace: string;
let client: McpClient;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-pro-'));
  client = new McpClient(workspace);
  await client.initialize();
}, 120000);

afterAll(async () => {
  client?.kill();
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

describe('MCP protocol', () => {
  it('initializes and lists all 58 tools with schemas', async () => {
    const tools = await client.listTools();
    expect(tools.length).toBe(58);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema).toBeTypeOf('object');
    }
  });

  it('exposes every required capability area', async () => {
    const names = (await client.listTools()).map((t) => t.name);
    for (const required of [
      'project_info', 'media_import', 'timeline_inspect',
      'clip_add', 'clip_move', 'clip_split', 'clip_trim', 'clip_remove',
      'track_add', 'undo', 'redo', 'export_video',
      'media_probe', 'media_inspect', 'timeline_at_time', 'timeline_gaps', 'track_inspect',
      'clip_slip', 'clip_roll', 'clip_duplicate', 'keyframe_set', 'keyframe_remove', 'keyframe_list',
      'effect_add', 'effect_update', 'effect_remove', 'effect_list', 'effect_catalog', 'editor_capabilities',
      'marker_add', 'marker_update', 'marker_remove', 'marker_list',
      'font_list', 'title_add', 'title_update', 'title_remove', 'title_list',
      'caption_add', 'caption_update', 'caption_remove', 'captions_list', 'captions_import', 'captions_export', 'caption_track_update',
    ]) {
      expect(names, `missing tool: ${required}`).toContain(required);
    }
  });

  it('returns a structured error for an unknown tool', async () => {
    const res = await client.request('tools/call', { name: 'nope_not_real', arguments: {} });
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe('NOT_FOUND');
  });

  it('rejects invalid arguments without throwing a stack', async () => {
    const res = await client.request('tools/call', {
      name: 'clip_move',
      arguments: { clipId: 'x' }, // missing required `start`
    });
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe('INVALID_ARGUMENT');
  });
});

describe('agent edit workflow', () => {
  it('edits and exports a real title-only composition through standard stdio', async () => {
    await client.call('project_create', { name: 'Titles', width: 320, height: 180, fps: 10 });
    const fonts = await client.call('font_list'); expect((fonts.fonts as Array<{ bundled: boolean }>)[0]!.bundled).toBe(true);
    const title = (await client.call('title_add', { text: '100% Δ · Ж', start: 0, end: 1, style: { fontSize: 24 } })).title as { id: string };
    await client.call('title_update', { titleId: title.id, style: { color: '#00ff00' } });
    expect(((await client.call('title_list')).titles as Array<{ style: { color: string } }>)[0]!.style.color).toBe('#00ff00');
    const summary = await client.call('export_preview'); expect(summary.duration).toBe(1);
    const result = await client.call('export_video', { outputPath: path.join(workspace, 'stdio-title.mp4'), preset: 'ultrafast' }); expect(result.clipCount).toBe(0); expect(result.durationSeconds).toBe(1); expect((await fs.stat(result.outputPath as string)).size).toBeGreaterThan(1000);
    const saved = path.join(workspace, 'Title project'); await client.call('project_save', { path: saved }); await client.call('title_remove', { titleId: title.id }); expect((await client.call('title_list')).titles).toEqual([]);
    await client.call('undo'); expect((await client.call('title_list')).titles).toHaveLength(1); await client.call('project_load', { path: saved }); expect((await client.call('title_list')).titles).toHaveLength(1);
  }, 30000);
  it('imports millisecond SRT over MCP and exports caption burn-in with exact sequence duration', async () => {
    await client.call('project_create', { name: 'Captions', width: 320, height: 180, fps: 10 });
    const imported = await client.call('captions_import', { content: '9\n00:00:00,503 --> 00:00:01,101\nHello from MCP' });
    expect(imported.warnings).toEqual([]);
    const list = await client.call('captions_list'); expect(list.timeDomain).toBe('integer milliseconds');
    expect((list.cues as Array<{ startMs: number; endMs: number; hasFrame: boolean }>)[0]).toMatchObject({ startMs: 503, endMs: 1101, hasFrame: true });
    expect((await client.call('captions_export')).content).toContain('00:00:00,503 --> 00:00:01,101\nHello from MCP');
    const result = await client.call('export_video', { outputPath: path.join(workspace, 'stdio-captions.mp4'), preset: 'ultrafast' });
    expect(result.durationSeconds).toBe(1.2); expect((await fs.stat(result.outputPath as string)).size).toBeGreaterThan(1000);
    await client.call('caption_track_update', { locked: true });
    const before = (await client.call('project_info')).revision;
    const refused = await client.request('tools/call', { name: 'caption_add', arguments: { text: 'No', startMs: 1200, endMs: 1500 } });
    expect((refused.result as { isError: boolean }).isError).toBe(true); expect((await client.call('project_info')).revision).toBe(before);
  }, 30000);
  it('edits, queries, saves and undoes fixed markers through actual stdio', async () => {
    await client.call('project_create', { name: 'Markers', fps: 30 });
    const result = await client.call('marker_add', { time: 1.019, label: 'नमस्ते', notes: 'Line 1\nLine 2', color: '#ff0080' });
    const marker = result.marker as { id: string; time: number }; expect(result.frame).toBe(31); expect(marker.time).toBe(31 / 30);
    await client.call('marker_update', { markerId: marker.id, label: 'Changed' });
    const target = path.join(workspace, 'Marker project'); await client.call('project_save', { path: target });
    await client.call('marker_remove', { markerId: marker.id }); expect((await client.call('marker_list')).markers).toEqual([]);
    await client.call('undo'); expect(((await client.call('marker_list')).markers as Array<{ label: string }>)[0]?.label).toBe('Changed');
    await client.call('project_load', { path: target }); expect(((await client.call('marker_list', { start: 1, end: 2 })).markers as Array<{ id: string }>)[0]?.id).toBe(marker.id);
    const before = (await client.call('project_info')).revision;
    const bad = await client.request('tools/call', { name: 'marker_update', arguments: { markerId: marker.id, label: '  ' } });
    expect((bad.result as { isError: boolean }).isError).toBe(true); expect((await client.call('project_info')).revision).toBe(before);
  });
  it('edits professional primitives, curves and effect CRUD over real stdio', async () => {
    await client.call('project_create', { name: 'Professional', fps: 30, width: 96, height: 64 });
    const media = await client.call('media_import', { path: path.join(FIXTURES, 'clipA.mp4') }), assetId = (media.asset as { id: string }).id;
    const tl = await client.call('timeline_inspect'), track = (tl.tracks as Array<{ id: string; kind: string }>).find((t) => t.kind === 'video')!;
    const a = (await client.call('clip_add', { trackId: track.id, assetId, sourceIn: 1, duration: 2 })).clip as { id: string };
    const b = (await client.call('clip_add', { trackId: track.id, assetId, start: 2, sourceIn: 4, duration: 2 })).clip as { id: string };
    const rolled = await client.call('clip_roll', { leftClipId: a.id, rightClipId: b.id, at: 2.5 }); expect((rolled.left as { duration: number }).duration).toBe(2.5);
    expect(((await client.call('clip_slip', { clipId: a.id, delta: .5 })).clip as { sourceIn: number }).sourceIn).toBe(1.5);
    await client.call('keyframe_set', { clipId: a.id, property: 'opacity', time: 0, value: .2, easing: 'ease-out' });
    await client.call('keyframe_set', { clipId: a.id, property: 'opacity', time: 1, value: 1 });
    const fx = (await client.call('effect_add', { clipId: a.id, type: 'color_adjust', params: { gamma: 1.2 } })).effect as { id: string };
    await client.call('effect_update', { clipId: a.id, effectId: fx.id, params: { brightness: .1 } });
    expect((await client.call('effect_list', { clipId: a.id })).effects).toHaveLength(1);
    expect(((await client.call('keyframe_list', { clipId: a.id })).transform as { opacity: { keyframes: unknown[] } }).opacity.keyframes).toHaveLength(2);
    const duplicate = (await client.call('clip_duplicate', { clipId: a.id, start: 4 })).clip as { id: string }; expect(duplicate.id).not.toBe(a.id);
    const revision = (await client.call('project_info')).revision;
    await expect(client.call('clip_split', { clipId: a.id, at: 1 })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(client.call('effect_add', { clipId: a.id, type: 'tracking' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect((await client.call('project_info')).revision).toBe(revision);
    await client.call('track_update', { trackId: track.id, locked: true });
    await expect(client.call('keyframe_remove', { clipId: a.id, property: 'opacity', time: 0 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await client.call('track_update', { trackId: track.id, locked: false });
    await client.call('keyframe_remove', { clipId: a.id, property: 'opacity', time: 0 }); await client.call('effect_remove', { clipId: a.id, effectId: fx.id });
    const catalog = await client.call('effect_catalog'); expect(catalog.effects).toHaveLength(7);
    expect((await client.call('editor_capabilities')).unsupported).toContain('tracking');
    const outputPath = path.join(workspace, 'professional-stdio.mp4'); await client.call('export_video', { outputPath, preset: 'ultrafast' }); expect((await fs.stat(outputPath)).size).toBeGreaterThan(1000);
  }, 120000);
  it('builds a real timeline entirely through tool calls', async () => {
    const info = await client.call('project_create', { name: 'Agent Edit', fps: 30, width: 640, height: 360 });
    expect(info.name).toBe('Agent Edit');

    const mediaA = await client.call('media_import', { path: path.join(FIXTURES, 'clipA.mp4') });
    const assetA = (mediaA.asset as { id: string }).id;
    const mediaB = await client.call('media_import', { path: path.join(FIXTURES, 'clipB.mp4') });
    const assetB = (mediaB.asset as { id: string }).id;

    const tl = await client.call('timeline_inspect');
    const tracks = tl.tracks as Array<{ id: string; kind: string }>;
    const videoTrack = tracks.find((t) => t.kind === 'video')!;

    const c1 = await client.call('clip_add', { trackId: videoTrack.id, assetId: assetA, start: 0, duration: 4 });
    const clip1 = (c1.clip as { id: string; start: number; duration: number });
    expect(clip1.start).toBe(0);
    expect(clip1.duration).toBe(4);

    const c2 = await client.call('clip_add', { trackId: videoTrack.id, assetId: assetB, start: 5, duration: 3 });
    const clip2 = (c2.clip as { id: string });

    // Split the first clip, trim the second, then remove a piece.
    const split = await client.call('clip_split', { clipId: clip1.id, at: 2 });
    const secondHalf = (split.second as { id: string }).id;

    await client.call('clip_trim', { clipId: clip2.id, edge: 'out', time: 7 });
    await client.call('clip_remove', { clipId: secondHalf, ripple: false });

    const final = await client.call('timeline_inspect');
    expect(final.trackCount).toBe(2);
    expect(final.duration).toBeGreaterThan(0);

    const dur = await client.call('timeline_duration');
    expect(dur.duration).toBeGreaterThan(0);
    const inspected = await client.call('media_inspect', { assetId: assetA });
    expect((inspected.clips as unknown[]).length).toBeGreaterThan(0);
    const atTime = await client.call('timeline_at_time', { time: 1 });
    expect((atTime.clips as Array<{ sourceTime: number }>)[0]!.sourceTime).toBe(1);
    const gapResult = await client.call('timeline_gaps', { trackId: videoTrack.id, until: 8 });
    expect(gapResult.gaps).toEqual([{ start: 2, end: 5 }, { start: 7, end: 8 }]);
    const track = await client.call('track_inspect', { trackId: videoTrack.id });
    expect((track.track as { kind: string }).kind).toBe('video');

    // Undo must be available and must work over the wire.
    const undone = await client.call('undo');
    expect(undone.undone).toBe(true);
    const redone = await client.call('redo');
    expect(redone.redone).toBe(true);
  }, 180000);

  it('exports a playable file through the tool surface', async () => {
    await client.call('project_create', { name: 'Export Test', fps: 30, width: 320, height: 180 });
    const media = await client.call('media_import', { path: path.join(FIXTURES, 'clipA.mp4') });
    const assetId = (media.asset as { id: string }).id;
    const tl = await client.call('timeline_inspect');
    const videoTrack = (tl.tracks as Array<{ id: string; kind: string }>).find((t) => t.kind === 'video')!;

    await client.call('clip_add', { trackId: videoTrack.id, assetId, start: 0, duration: 2 });

    const plan = await client.call('export_preview', {});
    expect(String(plan.summary)).toContain('filter');

    const out = path.join(workspace, 'agent-export.mp4');
    const result = await client.call('export_video', { outputPath: out, crf: 28, preset: 'ultrafast' });
    expect(result.outputPath).toBe(out);
    expect(result.clipCount).toBe(1);

    const stat = await fs.stat(out);
    expect(stat.size).toBeGreaterThan(1000);
  }, 180000);

  it('applies a transform that survives a round trip', async () => {
    const tl = await client.call('timeline_inspect');
    const track = (tl.tracks as Array<{ id: string; clips: Array<{ id: string }> }>).find((t) => t.clips.length > 0)!;
    const clipId = track.clips[0]!.id;

    const res = await client.call('clip_set_transform', { clipId, scale: 0.5, x: 0.25, opacity: 0.8 });
    const transform = res.transform as { scale: { value: number }; x: { value: number } };
    expect(transform.scale.value).toBe(0.5);
    expect(transform.x.value).toBe(0.25);

    const inspected = await client.call('clip_inspect', { clipId });
    const clip = inspected.clip as { transform: { scale: { value: number }; opacity: { value: number } } };
    expect(clip.transform.scale.value).toBe(0.5);
    expect(clip.transform.opacity.value).toBe(0.8);
  }, 120000);

  it('gives an actionable error when a clip id does not exist', async () => {
    await expect(client.call('clip_inspect', { clipId: 'clp_does_not_exist' })).rejects.toThrowError(/not found/i);
  });

  it('gives an actionable error when importing a missing file', async () => {
    await expect(
      client.call('media_import', { path: path.join(FIXTURES, 'ghost.mp4') }),
    ).rejects.toThrowError(/not found/i);
  });

  it('exports copied media through MCP using the owning workspace', async () => {
    await client.call('project_create', { name: 'Copied media', width: 320, height: 180, fps: 30 });
    const imported = await client.call('media_import', { path: path.join(FIXTURES, 'clipA.mp4'), copyIntoProject: true });
    const asset = imported.asset as { id: string; path: string; copied: boolean };
    expect(asset.copied).toBe(true);
    const tl = await client.call('timeline_inspect');
    const track = (tl.tracks as Array<{ id: string; kind: string }>).find((t) => t.kind === 'video')!;
    await client.call('clip_add', { trackId: track.id, assetId: asset.id, duration: 1 });
    const plan = await client.call('export_preview');
    expect(String(plan.summary)).toContain(asset.path);
    const outputPath = path.join(workspace, 'copied-agent-export.mp4');
    await client.call('export_video', { outputPath, preset: 'ultrafast' });
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(1000);
  }, 120000);
});
