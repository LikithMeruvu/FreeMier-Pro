
export function registerPanelsTimelineTimeline(ui) {
  // Dense timeline: scroll/zoom, clip thumbnails/waveforms, track controls and actual edit gestures.
  function renderTrackHeaders() {
    ui.$('track-headers').replaceChildren();
    for (const track of ui.tracks()) {
      const row = ui.node('div', 'track-header' + (track.id === ui.targetTrackId ? ' selected' : ''));
      row.dataset.trackId = track.id;
      const name = ui.button(track.name, 'Target source placement to ' + track.name, () => { ui.targetTrackId = track.id; ui.renderTrackHeaders(); }, 'track-name');
      const mute = ui.button('M', 'Mute ' + track.name, () => ui.command('track_update', { trackId: track.id, muted: !track.muted }), track.muted ? 'active' : '');
      mute.dataset.trackMute = track.id;
      const lock = ui.button(track.locked ? '◆' : '◇', 'Lock / unlock ' + track.name, () => ui.command('track_update', { trackId: track.id, locked: !track.locked }), track.locked ? 'active' : '');
      lock.dataset.trackLock = track.id;
      row.append(name, mute, lock, ui.node('span', 'track-kind', track.kind.toUpperCase() + (track.locked ? ' · LOCKED' : '')));
      ui.$('track-headers').append(row);
    }
    const tail = ui.node('div');
    tail.style.height = '24px';
    ui.$('track-headers').append(tail);
    ui.$('track-headers').scrollTop = ui.$('timeline-scroll').scrollTop;
    const chosen = ui.targetTrackId ?? ui.$('source-track').value;
    ui.$('source-track').replaceChildren(...ui.tracks().map((track) => { const opt = ui.node('option', '', track.name + (track.locked ? ' 🔒' : '')); opt.value = track.id; return opt; }));
    if (ui.project.timeline.tracks.some((t) => t.id === chosen))
      ui.$('source-track').value = chosen;
    ui.targetTrackId = ui.$('source-track').value;
  }

  function renderTimeline() {
    if (!ui.project)
      return;
    const scroll = ui.$('timeline-scroll'), dpr = devicePixelRatio || 1, ordered = ui.tracks();
    const width = Math.max(scroll.clientWidth, Math.max(10, ui.viewEnd() + 2) * ui.pps), height = Math.max(ordered.length * ui.TRACK_H + ui.RULER_H + 24, scroll.clientHeight);
    ui.$('timeline-area').style.width = width + 'px';
    ui.$('timeline-area').style.height = height + 'px';
    const visibleWidth = Math.max(1, scroll.clientWidth), visibleHeight = Math.max(1, scroll.clientHeight), offsetX = scroll.scrollLeft, offsetY = scroll.scrollTop;
    ui.canvas.style.width = visibleWidth + 'px';
    ui.canvas.style.height = visibleHeight + 'px';
    ui.canvas.width = Math.round(visibleWidth * dpr);
    ui.canvas.height = Math.round(visibleHeight * dpr);
    ui.ctx.setTransform(dpr, 0, 0, dpr, -offsetX * dpr, -offsetY * dpr);
    ui.canvas._xOf = (t) => t * ui.pps;
    ui.canvas._tOf = (x) => (x + scroll.scrollLeft) / ui.pps;
    ui.canvas.dataset.trackHeight = ui.TRACK_H;
    ui.canvas.dataset.rulerHeight = ui.RULER_H;
    ui.canvas.dataset.pps = ui.pps;
    ui.canvas.dataset.waveformPeaks = [...ui.waveforms.values()].reduce((n, peaks) => n + peaks.length, 0);
    ui.ctx.fillStyle = '#1a1c21';
    ui.ctx.fillRect(0, 0, width, height);
    ui.ctx.fillStyle = '#282b33';
    ui.ctx.fillRect(0, 0, width, ui.RULER_H);
    let step = .1;
    while (step * ui.pps < 70)
      step = step < 1 ? step * 2 : step < 2 ? 2 : step < 5 ? 5 : step * 2;
    ui.ctx.font = '9px ui-monospace,monospace';
    ui.ctx.textBaseline = 'middle';
    for (let t = Math.floor(offsetX / ui.pps / step) * step; t * ui.pps <= offsetX + visibleWidth; t += step) {
      const x = t * ui.pps;
      ui.ctx.strokeStyle = '#2f333d';
      ui.ctx.beginPath();
      ui.ctx.moveTo(x, ui.RULER_H);
      ui.ctx.lineTo(x, height);
      ui.ctx.stroke();
      ui.ctx.fillStyle = '#7c859a';
      ui.ctx.fillText(ui.tc(t), x + 5, 13);
    }
    for (const marker of ui.project.timeline.markers ?? []) {
      const x = marker.time * ui.pps;
      if (x < offsetX - 8 || x > offsetX + visibleWidth + 8)
        continue;
      ui.ctx.fillStyle = marker.color;
      ui.ctx.beginPath();
      ui.ctx.moveTo(x - 5, 0);
      ui.ctx.lineTo(x + 5, 0);
      ui.ctx.lineTo(x + 5, 13);
      ui.ctx.lineTo(x, 18);
      ui.ctx.lineTo(x - 5, 13);
      ui.ctx.closePath();
      ui.ctx.fill();
    }
    for (const title of ui.project.timeline.titles ?? []) {
      ui.ctx.fillStyle = '#b991eb';
      ui.ctx.fillRect(title.start * ui.pps, 19, Math.max(1, (title.end - title.start) * ui.pps), 3);
    }
    for (const cue of ui.project.timeline.captions?.cues ?? []) {
      ui.ctx.fillStyle = '#58c6bf';
      ui.ctx.fillRect(cue.startMs / 1000 * ui.pps, 23, Math.max(1, (cue.endMs - cue.startMs) / 1000 * ui.pps), 3);
    }
    for (let i = 0; i < ordered.length; i++) {
      const track = ordered[i], y = ui.RULER_H + i * ui.TRACK_H;
      if (y + ui.TRACK_H < offsetY || y > offsetY + visibleHeight)
        continue;
      ui.ctx.fillStyle = track.kind === 'audio' ? '#1d2525' : '#1e222a';
      ui.ctx.fillRect(0, y, width, ui.TRACK_H - 1);
      for (const clip of track.clips) {
        const x = clip.start * ui.pps, w = Math.max(2, clip.duration * ui.pps), h = ui.TRACK_H - 10, asset = ui.assetFor(clip), selected = clip.id === ui.selectedClipId;
        if (x + w < offsetX || x > offsetX + visibleWidth)
          continue;
        ui.ctx.globalAlpha = track.muted ? .4 : 1;
        ui.ctx.fillStyle = track.kind === 'video' ? '#3b6ea5' : '#3f7a68';
        ui.ctx.fillRect(x + 1, y + 4, w - 2, h);
        ui.ctx.fillStyle = track.kind === 'video' ? '#446784' : '#456f62';
        ui.ctx.fillRect(x + 1, y + 4, w - 2, 16);
        if (track.kind === 'audio') {
          if (asset?.hasAudio && !ui.waveforms.has(asset.id)) {
            ui.waveforms.set(asset.id, []);
            fetch(ui.BRIDGE + '/waveform', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: asset.id }) }).then((r) => r.json()).then((result) => {
              if (result.ok)
                ui.waveforms.set(asset.id, result.peaks); ui.renderTimeline();
            }).catch(() => { });
          }
          const peaks = ui.waveforms.get(asset?.id) ?? [];
          ui.ctx.strokeStyle = '#99c8b5';
          ui.ctx.beginPath();
          for (let px = x + 3; px < x + w - 3; px += 2) {
            const source = clip.sourceIn + (px - x) / ui.pps, peak = peaks[Math.min(peaks.length - 1, Math.floor(source / (asset?.duration || 1) * peaks.length))] ?? 0, ph = Math.min(1, peak * clip.volume) * 25;
            ui.ctx.moveTo(px, y + 38 - ph / 2);
            ui.ctx.lineTo(px, y + 38 + ph / 2);
          }
          ui.ctx.stroke();
        }
        else if (ui.thumbs.has(asset?.id)) {
          const cacheKey = 'image:' + asset.id;
          if (!ui.thumbs.has(cacheKey)) {
            const image = new Image();
            image.src = ui.thumbs.get(asset.id);
            image.onload = ui.renderTimeline;
            ui.thumbs.set(cacheKey, image);
          }
          const image = ui.thumbs.get(cacheKey);
          if (image.complete && image.naturalWidth) {
            ui.ctx.save();
            ui.ctx.beginPath();
            ui.ctx.rect(x + 2, y + 21, w - 4, 32);
            ui.ctx.clip();
            ui.ctx.globalAlpha = track.muted ? .3 : .75;
            for (let px = x + 2; px < x + w; px += 57)
              ui.ctx.drawImage(image, px, y + 21, 57, 32);
            ui.ctx.restore();
          }
        }
        ui.ctx.fillStyle = '#e0e6f0';
        ui.ctx.save();
        ui.ctx.beginPath();
        ui.ctx.rect(x + 4, y + 4, Math.max(0, w - 8), 15);
        ui.ctx.clip();
        ui.ctx.fillText(clip.label ?? asset?.name ?? 'Clip', x + 6, y + 12);
        ui.ctx.restore();
        if (clip.effects.some((e) => e.enabled)) {
          ui.ctx.fillStyle = '#c7b1eb';
          ui.ctx.fillText('fx', x + w - 15, y + 13);
        }
        if (selected) {
          ui.ctx.strokeStyle = '#c7bcff';
          ui.ctx.lineWidth = 2;
          ui.ctx.strokeRect(x + 1, y + 4, w - 2, h);
          ui.ctx.lineWidth = 1;
        }
        ui.ctx.globalAlpha = 1;
      }
    }
    ui.ctx.strokeStyle = '#f0a35e';
    ui.ctx.beginPath();
    ui.ctx.moveTo(ui.playhead * ui.pps + .5, ui.RULER_H);
    ui.ctx.lineTo(ui.playhead * ui.pps + .5, height);
    ui.ctx.stroke();
    ui.ctx.fillStyle = '#f0a35e';
    ui.ctx.beginPath();
    ui.ctx.moveTo(ui.playhead * ui.pps - 5, 20);
    ui.ctx.lineTo(ui.playhead * ui.pps + 5, 20);
    ui.ctx.lineTo(ui.playhead * ui.pps, 28);
    ui.ctx.fill();
  }

  function snapped(time, ignore) {
    let result = ui.q(Math.max(0, time));
    if (!ui.snap)
      return result;
    const targets = [0, ui.playhead, ...ui.project.timeline.tracks.flatMap((track) => track.clips.filter((clip) => clip.id !== ignore).flatMap((clip) => [clip.start, clip.start + clip.duration]))];
    const near = targets.sort((a, b) => Math.abs(a - result) - Math.abs(b - result))[0];
    if (Math.abs(near - result) * ui.pps < 8)
      result = ui.q(near);
    return result;
  }

  function setTool(next) {
    ui.tool = next; for (const button of document.querySelectorAll('[data-tool]'))
      button.classList.toggle('active', button.dataset.tool === next); ui.$('tool-status').textContent = next[0].toUpperCase() + next.slice(1); ui.canvas.style.cursor = next === 'razor' ? 'crosshair' : next === 'slip' || next === 'roll' ? 'ew-resize' : 'default';
  }

  function duplicateSelected() {
    if (ui.find())
      void ui.command('clip_duplicate', { clipId: ui.selectedClipId, start: Math.max(ui.duration(), ui.find().clip.start + ui.find().clip.duration) });
  }

  function deleteSelected() {
    if (ui.find())
      void ui.command('clip_remove', { clipId: ui.selectedClipId, ripple: ui.$('ripple-delete').checked });
  }
  Object.assign(ui, { renderTrackHeaders, renderTimeline, snapped, setTool, duplicateSelected, deleteSelected });
}
