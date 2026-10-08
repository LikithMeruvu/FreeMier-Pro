
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

  async function placeAsset(asset, trackId, range = {}) {
    const target = ui.project.timeline.tracks.find((track) => track.id === trackId);
    if (!target || target.locked) { ui.toast('Choose an unlocked track', 'error'); return null; }
    const mediaMode = ui.$('source-media-mode').value;
    if (mediaMode === 'video' && target.kind === 'audio') { ui.toast('Choose a video track for Video only', 'error'); return null; }
    let action = 'clip_add', args = { assetId: asset.id, trackId, ...range };
    if (mediaMode === 'audio' || target.kind === 'audio') {
      if (asset.kind !== 'audio' && !(asset.kind === 'video' && asset.hasAudio)) {
        ui.toast('This source has no audio', 'error'); return null;
      }
      const audioTrack = target.kind === 'audio' ? target : ui.tracks().find((track) => track.kind === 'audio' && !track.locked);
      if (!audioTrack) { ui.toast('Add or unlock an audio track first', 'error'); return null; }
      args.trackId = audioTrack.id;
    } else {
      if (asset.kind === 'audio') { ui.toast('Choose an audio track for this source', 'error'); return null; }
      if (mediaMode === 'auto' && asset.kind === 'video' && asset.hasAudio) {
        const audioTrack = ui.tracks().find((track) => track.kind === 'audio' && !track.locked);
        if (!audioTrack) { ui.toast('Add or unlock an audio track, or choose Video only', 'error'); return null; }
        action = 'clip_add_linked';
        args = { assetId: asset.id, videoTrackId: target.id, audioTrackId: audioTrack.id, ...range };
      }
    }
    const result = await ui.command(action, args);
    if (!result) return null;
    const clip = result.videoClip ?? result.clip;
    ui.select(clip.id);
    ui.setHead(clip.start);
    ui.toast('Placed ' + asset.name + (result.link ? ' with linked audio' : ''));
    return result;
  }

  async function toggleClipLink() {
    const selected = ui.find(ui.selectedClipId);
    if (!selected) { ui.toast('Select a clip first', 'error'); return; }
    const pair = (ui.project.timeline.clipLinks ?? []).find((link) => link.videoClipId === selected.clip.id || link.audioClipId === selected.clip.id);
    if (pair) {
      if (await ui.command('clip_unlink', { clipId: selected.clip.id })) ui.toast('Clips unlinked');
      return;
    }
    const linkedIds = new Set((ui.project.timeline.clipLinks ?? []).flatMap((link) => [link.videoClipId, link.audioClipId]));
    const candidates = ui.project.timeline.tracks.filter((track) => track.kind !== selected.track.kind)
      .flatMap((track) => track.clips).filter((clip) => !linkedIds.has(clip.id) && clip.assetId === selected.clip.assetId &&
        ['start', 'duration', 'sourceIn', 'sourceOut'].every((key) => Math.abs(clip[key] - selected.clip[key]) < 1e-6));
    if (!candidates.length) { ui.toast('Place matching video and audio with the same timing first', 'error'); return; }
    let partner = candidates[0];
    if (candidates.length > 1) {
      const dialog = ui.$('clip-link-dialog'), options = ui.$('clip-link-partner');
      options.replaceChildren(...candidates.map((clip) => { const option = ui.node('option', '', ui.find(clip.id).track.name + ' · ' + (clip.label ?? ui.assetFor(clip)?.name ?? 'Clip')); option.value = clip.id; return option; }));
      const accepted = await new Promise((resolve) => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'link'), { once: true }); dialog.returnValue = ''; dialog.showModal(); });
      if (!accepted) return;
      partner = candidates.find((clip) => clip.id === options.value);
    }
    const videoClipId = selected.track.kind === 'video' ? selected.clip.id : partner.id;
    const audioClipId = selected.track.kind === 'audio' ? selected.clip.id : partner.id;
    if (await ui.command('clip_link', { videoClipId, audioClipId })) ui.toast('Video and audio linked');
  }

  async function placeSource() {
    const asset = ui.project?.media.find((a) => a.id === ui.sourceAssetId), trackId = ui.$('source-track').value;
    if (!asset) {
      ui.toast('Open a source first', 'error');
      return;
    }
    const mode = ui.$('source-placement').value, args = { sourceIn: ui.sourceIn, duration: ui.sourceOut - ui.sourceIn, strict: mode === 'strict', ripple: mode === 'ripple' };
    if (mode !== 'append')
      args.start = ui.playhead;
    await placeAsset(asset, trackId, args);
  }
  Object.assign(ui, { openSource, updateSource, sourceSeek, placeSource, placeAsset, toggleClipLink });
}
