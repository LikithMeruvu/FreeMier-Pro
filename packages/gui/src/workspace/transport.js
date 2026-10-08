
export function registerWorkspaceTransport(ui) {
  function setHead(t, inspector = true) {
    ui.playhead = ui.q(Math.max(0, Math.min(ui.viewEnd(), t)));
    ui.updateTransport();
    ui.syncPreview();
    ui.renderTimeline();
    if (inspector)
      ui.renderInspector();
    const scroll = ui.$('timeline-scroll'), x = ui.playhead * ui.pps;
    if (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - 8)
      scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
  }

  function select(id) {
    ui.selectedClipId = id; ui.renderInspector(); ui.renderTimeline(); if (ui.browser === 'presets')
      ui.renderPresets(ui.$('bin-search').value.toLowerCase());
  }

  function updateTransport() {
    ui.$('scrub').value = ui.duration() ? String(ui.playhead / ui.duration() * 1000) : '0'; ui.$('timecode').textContent = ui.tc(ui.playhead) + ' / ' + ui.tc(ui.duration()); if (document.activeElement !== ui.$('timecode-input'))
      ui.$('timecode-input').value = ui.tc(ui.playhead); ui.$('duration-label').textContent = ui.tc(ui.duration()); ui.$('btn-play').textContent = ui.playing ? '❚❚' : '▶';
  }

  async function togglePlay() {
    if (!ui.duration())
      return; ui.sourceFocused = false; if (!ui.playing && ui.playhead >= ui.duration())
      ui.playhead = 0; ui.playing = !ui.playing; if (ui.playing)
      await ui.audioContext?.resume(); ui.updateTransport(); ui.syncPreview();
  }

  function tick(now) {
    const delta = Math.min(.1, (now - ui.lastTick) / 1000);
    ui.lastTick = now;
    if (ui.playing) {
      ui.playhead = Math.min(ui.duration(), ui.playhead + delta);
      if (ui.playhead >= ui.duration())
        ui.playing = false;
      ui.updateTransport();
      ui.syncPreview();
      ui.renderTimeline();
    }
    if (ui.sourcePlaying) {
      const asset = ui.project?.media.find((a) => a.id === ui.sourceAssetId);
      ui.sourceHead = Math.min(asset?.duration ?? 0, ui.sourceHead + delta);
      if (ui.sourceHead >= (asset?.duration ?? 0))
        ui.sourcePlaying = false;
      ui.updateSource();
    }
    const sel = ui.find(), analyser = sel && ui.decoders.get(sel.clip.id)?.analyser;
    if (ui.$('audio-meter-fill')) {
      let rms = 0;
      if (analyser) {
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
      }
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      ui.$('audio-meter-fill').style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
      ui.$('audio-meter-label').textContent = 'RMS ' + (Number.isFinite(db) ? db.toFixed(1) : '−∞') + ' dBFS · decoded output';
    }
    requestAnimationFrame(ui.tick);
  }
  Object.assign(ui, { setHead, select, updateTransport, togglePlay, tick });
}
