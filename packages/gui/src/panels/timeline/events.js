
export function bindTimelineEvents(ui) {
  ui.canvas.addEventListener('pointerdown', (event) => {
    if (!ui.project)
      return;
    ui.sourceFocused = false;
    const rect = ui.canvas.getBoundingClientRect(), x = event.clientX - rect.left + ui.$('timeline-scroll').scrollLeft, y = event.clientY - rect.top + ui.$('timeline-scroll').scrollTop, time = x / ui.pps;
    if (y < ui.RULER_H) {
      const marker = (ui.project.timeline.markers ?? []).find((m) => Math.abs(m.time * ui.pps - x) < 8);
      ui.setHead(marker?.time ?? time);
      return;
    }
    const track = ui.tracks()[Math.floor((y - ui.RULER_H) / ui.TRACK_H)];
    if (!track)
      return;
    ui.targetTrackId = track.id;
    const clip = track.clips.find((c) => time >= c.start && time < c.start + c.duration);
    ui.select(clip?.id ?? null);
    ui.renderTrackHeaders();
    if (!clip) {
      ui.setHead(time);
      return;
    }
    if (ui.tool === 'razor') {
      void ui.command('clip_split', { clipId: clip.id, at: ui.q(time) });
      return;
    }
    ui.setHead(time);
    ui.canvas.setPointerCapture(event.pointerId);
    const edge = ui.tool === 'select' && Math.abs(x - clip.start * ui.pps) < 6 ? 'in' : ui.tool === 'select' && Math.abs(x - (clip.start + clip.duration) * ui.pps) < 6 ? 'out' : null;
    ui.gesture = { pointer: event.pointerId, x, track, clip, edge, tool: ui.tool };
    ui.$('tool-status').textContent = edge ? 'Trim ' + edge : ui.tool;
  });
  ui.canvas.addEventListener('pointermove', (event) => {
    if (ui.gesture) {
      const delta = (event.clientX - ui.canvas.getBoundingClientRect().left + ui.$('timeline-scroll').scrollLeft - ui.gesture.x) / ui.pps;
      ui.$('tool-status').textContent = ui.gesture.tool + ' ' + (delta >= 0 ? '+' : '') + ui.q(delta).toFixed(2) + 's';
    }
  });
  ui.canvas.addEventListener('pointerup', async (event) => {
    if (!ui.gesture)
      return;
    const g = ui.gesture;
    ui.gesture = null;
    const rect = ui.canvas.getBoundingClientRect(), x = event.clientX - rect.left + ui.$('timeline-scroll').scrollLeft, delta = ui.q((x - g.x) / ui.pps);
    if (Math.abs(delta) < 1 / ui.fps()) {
      ui.$('tool-status').textContent = ui.tool;
      return;
    }
    if (g.tool === 'slip')
      await ui.command('clip_slip', { clipId: g.clip.id, delta });
    else if (g.tool === 'roll') {
      const right = g.track.clips.find((c) => Math.abs(c.start - (g.clip.start + g.clip.duration)) < 1e-6);
      if (right)
        await ui.command('clip_roll', { leftClipId: g.clip.id, rightClipId: right.id, at: ui.snapped(right.start + delta) });
      else
        ui.toast('Roll requires an adjacent clip to the right', 'error');
    }
    else if (g.edge)
      await ui.command('clip_trim', { clipId: g.clip.id, edge: g.edge, time: ui.snapped((g.edge === 'in' ? g.clip.start : g.clip.start + g.clip.duration) + delta, g.clip.id) });
    else {
      const target = ui.tracks()[Math.floor((event.clientY - rect.top + ui.$('timeline-scroll').scrollTop - ui.RULER_H) / ui.TRACK_H)];
      await ui.command('clip_move', { clipId: g.clip.id, start: ui.snapped(g.clip.start + delta, g.clip.id), trackId: target?.id ?? g.track.id });
    }
    ui.$('tool-status').textContent = ui.tool;
    ui.renderTimeline();
  });
  ui.canvas.addEventListener('pointercancel', () => { ui.gesture = null; });
  ui.canvas.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
  ui.canvas.addEventListener('drop', async (event) => {
    event.preventDefault();
    const id = event.dataTransfer.getData('application/x-freemier-asset') || event.dataTransfer.getData('text/plain');
    if (!ui.project.media.some((a) => a.id === id))
      return;
    const rect = ui.canvas.getBoundingClientRect(), track = ui.tracks()[Math.floor((event.clientY - rect.top + ui.$('timeline-scroll').scrollTop - ui.RULER_H) / ui.TRACK_H)];
    if (!track)
      return;
    const source = id === ui.sourceAssetId;
    await ui.placeAsset(ui.project.media.find((asset) => asset.id === id), track.id, { start: ui.snapped((event.clientX - rect.left + ui.$('timeline-scroll').scrollLeft) / ui.pps), sourceIn: source ? ui.sourceIn : 0, duration: source ? ui.sourceOut - ui.sourceIn : undefined, strict: true });
  });
  for (const button of document.querySelectorAll('[data-tool]'))
    button.addEventListener('click', () => ui.setTool(button.dataset.tool));
  ui.$('btn-snap').addEventListener('click', () => ui.persistWorkspacePatch({ snap: !ui.snap }));
  ui.$('btn-duplicate').addEventListener('click', ui.duplicateSelected);
  ui.$('btn-delete').addEventListener('click', ui.deleteSelected);
  ui.$('timeline-zoom').addEventListener('input', () => { ui.pps = Number(ui.$('timeline-zoom').value); ui.renderTimeline(); });
  ui.$('timeline-zoom').addEventListener('change', () => ui.persistWorkspacePatch({ timelineZoom: ui.pps }));
  ui.$('zoom-fit').addEventListener('click', () => { ui.pps = Math.max(20, Math.min(300, ui.$('timeline-scroll').clientWidth / Math.max(ui.duration() + .5, 1))); ui.$('timeline-zoom').value = ui.pps; ui.renderTimeline(); ui.persistWorkspacePatch({ timelineZoom: ui.pps }); });
  ui.$('timeline-scroll').addEventListener('scroll', () => { ui.$('track-headers').scrollTop = ui.$('timeline-scroll').scrollTop; ui.renderTimeline(); });
  new ResizeObserver(ui.renderTimeline).observe(ui.$('timeline-scroll'));
  ui.$('btn-add-video').addEventListener('click', () => ui.command('track_add', { kind: 'video' }));
  ui.$('btn-add-audio').addEventListener('click', () => ui.command('track_add', { kind: 'audio' }));
}
