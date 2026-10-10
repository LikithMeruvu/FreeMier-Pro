import { textRasterPayload } from '@freemier/shared/text';

export function registerConnectionClient(ui) {
  async function command(action, args = {}) {
    try {
      const result = await (await fetch(ui.BRIDGE + '/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, arguments: args }) })).json();
      if (!result.ok)
        throw new Error(result.error?.message ?? 'Command failed');
      const workspaceSettings = result.workspaceSettings ?? result.data?.workspaceSettings ?? result._bridge?.workspaceSettings ?? result.data?._bridge?.workspaceSettings;
      if (workspaceSettings)
        ui.receiveWorkspaceSettings?.(workspaceSettings, false);
      const projectProtection = result.projectProtection ?? result.data?.projectProtection ?? result._bridge?.projectProtection ?? result.data?._bridge?.projectProtection;
      if (projectProtection)
        ui.receiveProjectProtection?.(projectProtection, false, result.eventEpoch ?? result.data?.eventEpoch ?? result._bridge?.eventEpoch ?? result.data?._bridge?.eventEpoch);
      if (result._bridge)
        ui.applyState(result._bridge.project, result._bridge.revision, result._bridge);
      return result;
    }
    catch (error) {
      ui.toast(error.message, 'error');
      return null;
    }
  }

  function applyState(next, nextRevision, history = {}, { protectionAuthority = false } = {}) {
    ui.receiveWorkspaceSettings?.(history.workspaceSettings, false);
    ui.receiveProjectProtection?.(history.projectProtection, protectionAuthority, history.eventEpoch);
    if (history.eventEpoch !== undefined && history.eventSequence !== undefined) {
      if (ui.eventEpoch === history.eventEpoch && history.eventSequence <= ui.eventSequence && ui.project)
        return;
      ui.eventEpoch = history.eventEpoch;
      ui.eventSequence = history.eventSequence;
    }
    if (!next?.timeline)
      return;
    const previous = ui.project;
    const replace = previous?.id !== next.id;
    const changedMedia = new Set((previous?.media ?? []).filter((asset) => {
      const current = next.media.find((item) => item.id === asset.id);
      return !current || current.path !== asset.path || current.copied !== asset.copied;
    }).map((asset) => asset.id));
    for (const id of changedMedia) {
      ui.thumbs.delete(id);
      ui.thumbs.delete('image:' + id);
      ui.pendingThumbs.delete(id);
      ui.waveforms.delete(id);
    }
    for (const [id, entry] of ui.decoders) {
      const clip = previous?.timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === id);
      if (replace || (clip && changedMedia.has(clip.assetId))) {
        ui.discard(entry);
        ui.decoders.delete(id);
      }
    }
    if (replace)
      ui.titleRasters.clear();
    ui.project = next;
    // Asset ids and bridge URLs stay stable after relink. Reload the actual
    // decoder instead of continuing to display bytes from its old location.
    if (!replace && changedMedia.has(ui.sourceAssetId) && ui.sourceEl) {
      const asset = next.media.find((item) => item.id === ui.sourceAssetId);
      ui.sourceEl.pause?.();
      if (asset) {
        ui.sourceEl.src = ui.mediaUrl(asset);
        ui.sourceEl.load?.();
      } else {
        ui.sourceEl.remove();
        ui.sourceEl = null;
        ui.sourceAssetId = null;
        ui.sourcePlaying = false;
      }
    }
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
    ui.renderTransitionsPanel?.();
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
    let reconnectGeneration = 0;
    source.onopen = () => {
      const generation = ++reconnectGeneration;
      ui.$('live-status').className = 'live-status on'; ui.$('live-text').textContent = 'Live MCP';
      void fetch(ui.BRIDGE + '/state').then((response) => response.json()).then((state) => {
        if (generation === reconnectGeneration) ui.receiveWorkspaceSettings?.(state.workspaceSettings, true);
        if (generation === reconnectGeneration) ui.receiveProjectProtection?.(state.projectProtection, true, state.eventEpoch);
      }).catch(() => {});
    };
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
      if (event.type === 'snapshot' || event.type === 'change') {
        ui.receiveWorkspaceSettings?.(event.state?.workspaceSettings, event.type === 'snapshot');
        if (event.type === 'snapshot') ui.receiveProjectProtection?.(event.state?.projectProtection, true, event.state?.eventEpoch);
        ui.applyState(event.state.project ?? event.state, event.revision, event.state, { protectionAuthority: event.type === 'snapshot' });
      } else if (event.type === 'workspace-settings')
        ui.receiveWorkspaceSettings?.(event.workspaceSettings, false);
      else if (event.type === 'project-protection')
        ui.receiveProjectProtection?.(event.projectProtection, false, event.eventEpoch);
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
