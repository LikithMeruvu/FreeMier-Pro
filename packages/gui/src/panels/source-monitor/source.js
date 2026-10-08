
export function registerPanelsSourceMonitorSource(ui) {
  function openSource(id) {
    const asset = ui.project?.media.find((a) => a.id === id);
    if (!asset)
      return;
    ui.sourceEl?.pause?.();
    ui.$('source-stage').querySelectorAll('video,audio,img').forEach((el) => el.remove());
    ui.sourceAssetId = id;
    ui.sourceHead = ui.sourceIn = 0;
    ui.sourceOut = asset.duration;
    ui.sourcePlaying = false;
    ui.sourceEl = ui.node(asset.kind === 'image' ? 'img' : asset.kind === 'audio' ? 'audio' : 'video');
    ui.sourceEl.crossOrigin = 'anonymous';
    ui.sourceEl.src = ui.mediaUrl(asset);
    ui.sourceEl.preload = 'auto';
    ui.sourceEl.dataset.assetId = id;
    ui.sourceEl.addEventListener('loadeddata', ui.updateSource);
    ui.sourceEl.addEventListener('load', ui.updateSource);
    ui.$('source-stage').append(ui.sourceEl);
    ui.sourceFocused = true;
    ui.renderMediaBin();
    ui.updateSource();
  }

  function updateSource() {
    const asset = ui.project?.media.find((a) => a.id === ui.sourceAssetId);
    ui.$('source-empty').hidden = !!asset;
    ui.$('source-name').textContent = asset?.name ?? 'No selection';
    ui.$('source-timecode').textContent = ui.tc(ui.sourceHead);
    ui.$('source-range').textContent = asset ? 'I ' + ui.tc(ui.sourceIn) + ' · O ' + ui.tc(ui.sourceOut) : 'No in / out';
    ui.$('source-scrub').value = String(asset?.duration ? ui.sourceHead / asset.duration * 1000 : 0);
    ui.$('source-play').textContent = ui.sourcePlaying ? '❚❚' : '▶';
    if (asset && ui.sourceEl && asset.kind !== 'image') {
      if (Math.abs(ui.sourceEl.currentTime - ui.sourceHead) > (ui.sourcePlaying ? .12 : .001))
        try {
          ui.sourceEl.currentTime = ui.sourceHead;
        }
        catch { }
      if (ui.sourcePlaying)
        ui.sourceEl.play().catch(() => { });
      else
        ui.sourceEl.pause();
    }
  }

  function sourceSeek(t) {
    const asset = ui.project?.media.find((a) => a.id === ui.sourceAssetId); if (!asset)
      return; ui.sourceHead = ui.q(Math.max(0, Math.min(asset.duration, t))); ui.updateSource();
  }

  async function placeSource() {
    const asset = ui.project?.media.find((a) => a.id === ui.sourceAssetId), trackId = ui.$('source-track').value;
    if (!asset) {
      ui.toast('Open a source first', 'error');
      return;
    }
    const mode = ui.$('source-placement').value, args = { assetId: asset.id, trackId, sourceIn: ui.sourceIn, duration: ui.sourceOut - ui.sourceIn, strict: mode === 'strict', ripple: mode === 'ripple' };
    if (mode !== 'append')
      args.start = ui.playhead;
    const result = await ui.command('clip_add', args);
    if (result) {
      ui.select(result.clip.id);
      ui.setHead(result.clip.start);
      ui.toast('Placed ' + asset.name);
    }
  }
  Object.assign(ui, { openSource, updateSource, sourceSeek, placeSource });
}
