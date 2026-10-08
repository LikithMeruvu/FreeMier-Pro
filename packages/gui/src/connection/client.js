import { textRasterPayload } from '@freemier/shared/text';

export function registerConnectionClient(ui) {
  async function command(action, args = {}) {
    try {
      const result = await (await fetch(ui.BRIDGE + '/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) })).json();
      if (!result.ok)
        throw new Error(result.error?.message ?? 'Command failed');
      if (result._bridge)
        ui.applyState(result._bridge.project, result._bridge.revision, result._bridge);
      return result;
    }
    catch (error) {
      ui.toast(error.message, 'error');
      return null;
    }
  }

  function applyState(next, nextRevision, history = {}) {
    if (!next?.timeline)
      return;
    if (history.eventEpoch !== undefined && history.eventSequence !== undefined) {
      if (ui.eventEpoch === history.eventEpoch && history.eventSequence <= ui.eventSequence && ui.project)
        return;
      ui.eventEpoch = history.eventEpoch;
      ui.eventSequence = history.eventSequence;
    }
    const replace = ui.project?.id !== next.id;
    if (replace)
      ui.titleRasters.clear();
    ui.project = next;
    ui.revision = nextRevision ?? ui.revision;
    const rasterPayloads = new Set([...(next.timeline.titles ?? []).map((t) => textRasterPayload(t.text, t.style, next.timeline.width, next.timeline.height)), ...(next.timeline.captions?.cues ?? []).map((c) => textRasterPayload(c.text, next.timeline.captions.style, next.timeline.width, next.timeline.height))]);
    for (const key of ui.titleRasters.keys())
      if (!rasterPayloads.has(key))
        ui.titleRasters.delete(key);
    if (replace) {
      ui.selectedClipId = null;
      ui.playhead = 0;
      ui.playing = false;
      ui.sourcePlaying = false;
      ui.sourceAssetId = null;
      ui.sourceEl?.pause?.();
      ui.$('source-stage').querySelectorAll('video,audio,img').forEach((el) => el.remove());
      ui.sourceEl = null;
      ui.thumbs.clear();
      ui.pendingThumbs.clear();
      ui.waveforms.clear();
    }
    ui.playhead = Math.min(ui.playhead, ui.viewEnd());
    if (!ui.find())
      ui.selectedClipId = null;
    ui.$('project-name').textContent = next.name;
    ui.$('sequence-name').textContent = next.timeline.name ?? 'Sequence';
    ui.$('project-format').textContent = next.timeline.width + ' × ' + next.timeline.height + ' · ' + next.timeline.fps + ' fps';
    ui.$('revision').textContent = 'rev ' + ui.revision;
    ui.$('btn-undo').disabled = history.canUndo === false;
    ui.$('btn-redo').disabled = history.canRedo === false;
    ui.renderMediaBin();
    ui.renderTrackHeaders();
    ui.renderTimeline();
    ui.renderInspector();
    ui.syncPreview();
    ui.updateTransport();
    ui.updateSource();
    ui.report();
  }

  function report() {
    ui.api?.reportState?.({ revision: ui.revision, projectName: ui.project?.name, mediaCount: ui.project?.media.length ?? 0, clipCount: ui.project?.timeline.tracks.reduce((n, t) => n + t.clips.length, 0) ?? 0, trackCount: ui.project?.timeline.tracks.length ?? 0, duration: ui.duration(), mediaItemsRendered: ui.$('media-bin').querySelectorAll('.media-item').length, previewVideos: ui.$('preview-stage').querySelectorAll('video').length, lastRenderedAt: Date.now() });
  }

  function connect() {
    const source = new EventSource(ui.BRIDGE + '/events');
    source.onopen = () => { ui.$('live-status').className = 'live-status on'; ui.$('live-text').textContent = 'Live MCP'; };
    source.onerror = () => { ui.$('live-status').className = 'live-status off'; ui.$('live-text').textContent = 'Reconnecting'; };
    source.onmessage = ({ data }) => {
      let event;
      try {
        event = JSON.parse(data);
      }
      catch {
        return;
      }
      // SSE is ordered. Undo restores an earlier snapshot revision and must repaint.
      if (event.type === 'snapshot' || event.type === 'change')
        ui.applyState(event.state.project ?? event.state, event.revision, event.state);
      else if (event.type === 'export-progress')
        ui.showProgress(event.fraction);
    };
  }

  async function boot() {
    try {
      await ui.api.getInfo();
    }
    catch { } ui.connect(); try {
      const state = await (await fetch(ui.BRIDGE + '/state')).json();
      if (!ui.project)
        ui.applyState(state.project, state.revision, state);
    }
    catch { }
  }
  Object.assign(ui, { command, applyState, report, connect, boot });
}
