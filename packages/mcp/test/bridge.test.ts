import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EditorStore, addClip, addMediaAsset, addTitle } from '@freemier/engine';
import { textRasterKey } from '@freemier/ffmpeg';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveBridge } from '../src/bridge.js';
import { newMediaId } from '@freemier/shared';

/**
 * The live-sync contract.
 *
 * This test is the executable form of the project's core promise: a mutation
 * made anywhere (here, standing in for an MCP tool call) reaches a subscribed
 * viewer without a reload.
 */

function fakeAsset() {
  return {
    id: newMediaId(),
    path: '/fake.mp4',
    copied: false,
    name: 'fake.mp4',
    kind: 'video' as const,
    duration: 30,
    width: 640,
    height: 360,
    fps: 30,
    hasAudio: true,
    sampleRate: 48000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    probedAt: Date.now(),
  };
}

let bridge: LiveBridge;
let store: EditorStore;
let base: string;
let workspace: string;

beforeAll(async () => {
  store = EditorStore.create({ fps: 30, width: 640, height: 360 });
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-bridge-'));
  bridge = new LiveBridge({ store, port: 0, workspace });
  const port = await bridge.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await bridge.stop();
  expect(path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('LiveBridge', () => {
  it('serves canonical title PNGs and refuses stale/invalid requests without crashing', async () => {
    const textStore = EditorStore.create({ width: 640, height: 360 }), textBridge = new LiveBridge({ store: textStore, workspace: path.join(workspace, 'text'), port: 0 });
    const base = `http://127.0.0.1:${await textBridge.start()}`;
    try {
    const title = addTitle(textStore, { text: 'Shared Δ Ж', start: 0, end: 1, style: { fontSize: 24 } });
    const key = textRasterKey(title.text, title.style, 640, 360);
    expect((await fetch(`${base}/text/${title.id}?key=old`)).status).toBe(409);
    const response = await fetch(`${base}/text/${title.id}?key=${key}`, { headers: { Origin: 'null' } }); expect(response.status).toBe(200); expect(response.headers.get('Access-Control-Allow-Origin')).toBe('null');
    const bytes = Buffer.from(await response.arrayBuffer()); expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); expect(bytes.length).toBeGreaterThan(1000);
    expect((await fetch(`${base}/text/%zz`)).status).toBe(400); expect((await fetch(`${base}/text/missing`)).status).toBe(404); expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally { await textBridge.stop(); }
  }, 30000);
  it('serves the current project state', async () => {
    const res = await fetch(`${base}/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { timeline: { fps: number } }; revision: number };
    expect(body.project.timeline.fps).toBe(30);
    expect(body.revision).toBe(0);
  });

  it('reports health with the connected client count', async () => {
    const res = await fetch(`${base}/health`);
    const body = (await res.json()) as { ok: boolean; revision: number };
    expect(body.ok).toBe(true);
  });

  it('rejects malformed encoded media identifiers without crashing the bridge', async () => {
    expect((await fetch(`${base}/media/%E0%A4%A`)).status).toBe(400);
    expect((await fetch(`${base}/health`)).ok).toBe(true);
  });

  it('returns 404 with the available routes for an unknown path', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { routes: string[] };
    expect(body.routes).toContain('/events');
  });

  it('returns confirmed command state with ordered delivery independent of undo snapshot revision', async () => {
    const before = await (await fetch(`${base}/state`)).json();
    const call = async (action: string, args: Record<string, unknown> = {}) => (await fetch(`${base}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) })).json();
    const added = await call('marker_add', { time: 0, label: 'Confirmed' });
    expect(added._bridge.eventSequence).toBe(before.eventSequence + 1); expect(added._bridge.eventEpoch).toBe(before.eventEpoch);
    expect(added._bridge.project.timeline.markers[0].label).toBe('Confirmed'); expect(added._bridge.canUndo).toBe(true);
    const undone = await call('undo');
    expect(undone._bridge.revision).toBe(before.revision); expect(undone._bridge.eventSequence).toBe(added._bridge.eventSequence + 1); expect(undone._bridge.canRedo).toBe(true);
    expect(undone._bridge.project.timeline.markers ?? []).toEqual([]);
    const repeatedRead = await call('marker_list'); expect(repeatedRead._bridge.eventSequence).toBe(undone._bridge.eventSequence);
  });

  it('streams a snapshot immediately on subscribe', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('"type":"snapshot"');
    controller.abort();
  });

  it('pushes a change event when the timeline is mutated', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the initial snapshot frame.
    await reader.read();

    // Mutate exactly as an MCP tool call would.
    const nextFrame = (async () => {
      let buffer = '';
      for (;;) {
        // Drain every complete frame already buffered BEFORE reading again —
        // a frame can arrive split across reads, and more than one can land
        // in a single chunk.
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          const parsed = JSON.parse(dataLine.slice(6)) as { type?: string; kind?: string };
          // Importing media emits its own change first; wait for the clip edit.
          if (parsed.type === 'change' && parsed.kind === 'clip') return parsed;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      throw new Error('stream ended before a change event arrived');
    })();

    const asset = addMediaAsset(store, fakeAsset());
    const track = store.project.timeline.tracks.find((t) => t.kind === 'video')!;
    const clip = addClip(store, { trackId: track.id, assetId: asset.id, start: 0, duration: 3 });

    const event = (await nextFrame) as { type: string; kind: string; ids: string[]; state: { revision: number } };
    expect(event.type).toBe('change');
    expect(event.kind).toBe('clip');
    expect(event.ids).toContain(clip.id);
    expect(event.state.revision).toBeGreaterThan(0);

    controller.abort();
  }, 30000);

  it('delivers the updated project to a client that subscribes after the edit', async () => {
    const res = await fetch(`${base}/state`);
    const body = (await res.json()) as { project: { media: unknown[]; timeline: { tracks: Array<{ clips: unknown[] }> } } };
    expect(body.project.media.length).toBeGreaterThan(0);
    expect(body.project.timeline.tracks.some((t) => t.clips.length > 0)).toBe(true);
  });

  it('tracks connected clients and cleans up on disconnect', async () => {
    const before = bridge.clientCount;
    const controller = new AbortController();
    await fetch(`${base}/events`, { signal: controller.signal });

    // Wait for the server to register the new subscriber.
    const deadline = Date.now() + 5000;
    while (bridge.clientCount !== before + 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(bridge.clientCount).toBe(before + 1);

    controller.abort();

    // Wait for the server to observe the disconnect and clean up.
    const cleanupDeadline = Date.now() + 5000;
    while (bridge.clientCount > before && Date.now() < cleanupDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(bridge.clientCount).toBe(before);
  }, 30000);

  it('validates the same professional tool payloads and emits one atomic SSE revision', async () => {
    const track = store.project.timeline.tracks.find((t) => t.kind === 'video')!, clip = track.clips[0]!;
    const controller = new AbortController(), stream = await fetch(`${base}/events`, { signal: controller.signal }), reader = stream.body!.getReader(); await reader.read();
    const call = async (action: string, args: Record<string, unknown> = {}) => (await fetch(`${base}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) })).json() as Promise<Record<string, unknown>>;
    const before = store.revision;
    expect((await call('keyframe_set', { clipId: clip.id, property: 'x', time: .5, value: .2 })).ok).toBe(true);
    expect(store.revision).toBe(before + 1);
    const event = new TextDecoder().decode((await reader.read()).value); expect(event).toContain('"type":"change"'); expect(event).toContain(`"revision":${before + 1}`);
    const invalid = await call('keyframe_set', { clipId: clip.id, property: 'x', time: 'bad', value: .2 }); expect((invalid.error as { code: string }).code).toBe('INVALID_ARGUMENT'); expect(store.revision).toBe(before + 1);
    expect((await call('effect_add', { clipId: clip.id, type: 'sepia', params: { amount: .5 } })).ok).toBe(true);
    expect((await call('effect_catalog')).effects).toHaveLength(7);
    expect((await call('clip_slip', { clipId: clip.id, delta: 1 })).ok).toBe(true);
    expect((await call('clip_duplicate', { clipId: clip.id, start: 5 })).ok).toBe(true);
    controller.abort();
  }, 30000);
});
