import { evaluateTransform } from '@freemier/shared/animation';
import { createColorProcessor, fadeEnvelope } from '@freemier/shared/effects';
import { textRasterPayload } from '@freemier/shared/text';

export function registerPanelsProgramMonitorProgram(ui) {
  function overlayRaster(id, text, style, route = 'text') {
    const { width, height } = ui.project.timeline, payload = textRasterPayload(text, style, width, height);
    if (ui.titleRasters.get(payload)?.error && Date.now() - ui.titleRasters.get(payload).failed > 1000)
      ui.titleRasters.delete(payload);
    if (!ui.titleRasters.has(payload)) {
      const entry = { image: null, error: null };
      ui.titleRasters.set(payload, entry);
      crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)).then(async (bytes) => {
        const key = [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, '0')).join('');
        const response = await fetch(ui.BRIDGE + '/' + route + '/' + encodeURIComponent(id) + '?key=' + key);
        if (!response.ok) {
          const body = await response.json();
          throw new Error(body.error?.message ?? body.error ?? 'Text renderer unavailable');
        }
        const url = URL.createObjectURL(await response.blob()), image = new Image();
        image.onload = () => { URL.revokeObjectURL(url); entry.image = image; ui.drawProgram(); };
        image.onerror = () => { URL.revokeObjectURL(url); entry.error = 'Text PNG decode failed'; entry.failed = Date.now(); ui.drawProgram(); };
        image.src = url;
      }).catch((error) => { entry.error = error.message; entry.failed = Date.now(); ui.drawProgram(); });
    }
    return ui.titleRasters.get(payload);
  }

  function titleRaster(title) { return ui.overlayRaster(title.id, title.text, title.style); }

  function captionRaster(cue, style) { return ui.overlayRaster(cue.id, cue.text, style, 'caption-text'); }

  function discard(entry) {
    if (entry.frameRequest !== undefined)
      entry.el.cancelVideoFrameCallback(entry.frameRequest); entry.el.pause?.(); entry.el.remove(); entry.source?.disconnect(); entry.gain?.disconnect(); entry.analyser?.disconnect();
  }

  function syncPreview() {
    if (!ui.project)
      return;
    const active = [];
    for (const track of [...ui.project.timeline.tracks].sort((a, b) => a.order - b.order))
      if (!track.muted)
        for (const clip of track.clips)
          if (ui.playhead >= clip.start - 1e-6 && ui.playhead < clip.start + clip.duration - 1e-6)
            active.push({ clip, track, asset: ui.assetFor(clip) });
    const wanted = new Set(active.map(({ clip }) => clip.id));
    for (const [id, entry] of ui.decoders)
      if (!wanted.has(id)) {
        ui.discard(entry);
        ui.decoders.delete(id);
      }
    for (const { clip, track, asset } of active) {
      if (!asset)
        continue;
      const tag = asset.kind === 'image' ? 'IMG' : track.kind === 'audio' || asset.kind === 'audio' ? 'AUDIO' : 'VIDEO';
      let entry = ui.decoders.get(clip.id);
      if (entry && (entry.el.tagName !== tag || entry.el.src !== ui.mediaUrl(asset))) {
        ui.discard(entry);
        ui.decoders.delete(clip.id);
        entry = null;
      }
      if (!entry) {
        const el = ui.node(tag.toLowerCase());
        el.crossOrigin = 'anonymous';
        el.src = ui.mediaUrl(asset);
        el.dataset.clipId = clip.id;
        el.preload = 'auto';
        el.muted = track.kind === 'video';
        el.volume = 1;
        entry = { el, ...(tag === 'AUDIO' && asset.hasAudio ? ui.audioBus(el) : {}) };
        ui.decoders.set(clip.id, entry);
        ui.$('preview-stage').append(el);
        el.addEventListener('loadeddata', () => { ui.drawProgram(); ui.report(); });
        el.addEventListener('seeked', ui.drawProgram);
        el.addEventListener('load', ui.drawProgram);
        if (tag === 'VIDEO') {
          const presented = () => {
            if (ui.decoders.get(clip.id) !== entry)
              return;
            ui.drawProgram();
            entry.frameRequest = el.requestVideoFrameCallback(presented);
          };
          entry.frameRequest = el.requestVideoFrameCallback(presented);
        }
      }
      const sourceTime = clip.sourceIn + ui.playhead - clip.start, el = entry.el;
      if (tag !== 'IMG' && Math.abs(el.currentTime - sourceTime) > (ui.playing ? .12 : .001))
        try {
          el.currentTime = Math.max(0, sourceTime);
        }
        catch { }
      const transform = evaluateTransform(clip.transform, ui.local(clip));
      el.dataset.transform = JSON.stringify(transform);
      el.style.transform = 'translate(' + transform.x * ui.program.width + 'px, ' + transform.y * ui.program.height + 'px) scale(' + transform.scale + ') rotate(' + transform.rotation + 'deg)';
      el.style.opacity = String(transform.opacity);
      let gain = clip.volume;
      for (const effect of clip.effects)
        if (effect.enabled && effect.type === 'audio_fade')
          gain *= fadeEnvelope(effect, ui.local(clip));
      if (entry.gain) {
        entry.gain.gain.value = gain;
        el.dataset.gain = String(gain);
      }
      if (tag !== 'IMG') {
        if (ui.playing)
          el.play().catch(() => { });
        else
          el.pause();
      }
    }
    ui.$('preview-stage').dataset.activeClips = String(active.length);
    ui.$('preview-empty').hidden = active.some((a) => a.track.kind === 'video' && a.asset?.kind !== 'audio');
    ui.drawProgram();
  }

  function spatialSharpen(context, width, height, amount) {
    const image = context.getImageData(0, 0, width, height), data = image.data, original = new Uint8ClampedArray(data), kernel = [1, 4, 6, 4, 1];
    // Real spatial processing; RGB kernel approximation of export's luma unsharp.
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let channel = 0; channel < 3; channel++) {
          let blurred = 0;
          for (let ky = -2; ky <= 2; ky++)
            for (let kx = -2; kx <= 2; kx++) {
              const sx = Math.max(0, Math.min(width - 1, x + kx)), sy = Math.max(0, Math.min(height - 1, y + ky));
              blurred += original[(sy * width + sx) * 4 + channel] * kernel[kx + 2] * kernel[ky + 2] / 256;
            }
          const index = (y * width + x) * 4 + channel;
          data[index] = original[index] + amount * (original[index] - blurred);
        }
    context.putImageData(image, 0, 0);
  }

  function drawProgram() {
    if (!ui.project || ui.applying)
      return;
    ui.applying = true;
    try {
      const stage = ui.$('preview-stage'), aspect = ui.project.timeline.width / ui.project.timeline.height;
      const width = Math.max(2, Math.round(Math.min(stage.clientWidth, stage.clientHeight * aspect))), height = Math.max(2, Math.round(width / aspect));
      if (ui.program.width !== width || ui.program.height !== height) {
        ui.program.width = ui.scratch.width = ui.scratch2.width = width;
        ui.program.height = ui.scratch.height = ui.scratch2.height = height;
      }
      ui.programCtx.fillStyle = '#000';
      ui.programCtx.fillRect(0, 0, width, height);
      const sc = ui.scratch.getContext('2d', { willReadFrequently: true }), aux = ui.scratch2.getContext('2d');
      let approximation = false, unknown = false;
      for (const track of [...ui.project.timeline.tracks].sort((a, b) => a.order - b.order))
        if (track.kind === 'video' && !track.muted)
          for (const clip of track.clips) {
            const el = ui.decoders.get(clip.id)?.el, asset = ui.assetFor(clip);
            if (!el || !asset || el.tagName === 'AUDIO' || (el.tagName === 'VIDEO' ? el.readyState < 2 : !el.complete))
              continue;
            sc.clearRect(0, 0, width, height);
            const iw = el.videoWidth || el.naturalWidth, ih = el.videoHeight || el.naturalHeight;
            if (!iw || !ih)
              continue;
            const fit = Math.min(width / iw, height / ih);
            sc.drawImage(el, (width - iw * fit) / 2, (height - ih * fit) / 2, iw * fit, ih * fit);
            let envelope = 1;
            for (const effect of clip.effects) {
              if (!effect.enabled)
                continue;
              if (['color_adjust', 'grayscale', 'sepia'].includes(effect.type)) {
                const cacheKey = effect.type + JSON.stringify(effect.params);
                if (!ui.pixelProcessors.has(cacheKey)) {
                  if (ui.pixelProcessors.size > 100)
                    ui.pixelProcessors.clear();
                  ui.pixelProcessors.set(cacheKey, createColorProcessor(effect.type, effect.params));
                }
                const process = ui.pixelProcessors.get(cacheKey), image = sc.getImageData(0, 0, width, height), data = image.data;
                for (let i = 0; i < data.length; i += 4) {
                  const rgb = process([data[i], data[i + 1], data[i + 2]]);
                  data[i] = rgb[0];
                  data[i + 1] = rgb[1];
                  data[i + 2] = rgb[2];
                }
                sc.putImageData(image, 0, 0);
              }
              else if (effect.type === 'blur') {
                approximation = true;
                aux.clearRect(0, 0, width, height);
                aux.filter = 'blur(' + Number(effect.params.radius) * width / ui.project.timeline.width + 'px)';
                aux.drawImage(ui.scratch, 0, 0);
                aux.filter = 'none';
                sc.clearRect(0, 0, width, height);
                sc.drawImage(ui.scratch2, 0, 0);
              }
              else if (effect.type === 'sharpen') {
                approximation = true;
                ui.spatialSharpen(sc, width, height, Number(effect.params.amount));
              }
              else if (effect.type === 'video_fade')
                envelope *= fadeEnvelope(effect, ui.local(clip));
              else if (effect.type !== 'audio_fade')
                unknown = true;
            }
            const t = evaluateTransform(clip.transform, ui.local(clip));
            ui.programCtx.save();
            ui.programCtx.globalAlpha = t.opacity * envelope;
            ui.programCtx.translate(width / 2 + t.x * width, height / 2 + t.y * height);
            ui.programCtx.rotate(t.rotation * Math.PI / 180);
            ui.programCtx.scale(t.scale, t.scale);
            ui.programCtx.drawImage(ui.scratch, -width / 2, -height / 2);
            ui.programCtx.restore();
          }
      let textPending = false, textError = null;
      for (const title of ui.project.timeline.titles ?? [])
        if (ui.playhead >= title.start - 1e-6 && ui.playhead < title.end - 1e-6) {
          const raster = ui.titleRaster(title);
          if (raster.image)
            ui.programCtx.drawImage(raster.image, 0, 0, width, height);
          else {
            textPending = true;
            textError = raster.error;
          }
        }
      const captions = ui.project.timeline.captions;
      if (captions?.enabled)
        for (const cue of captions.cues)
          if (ui.playhead * 1000 >= cue.startMs && ui.playhead * 1000 < cue.endMs) {
            const raster = ui.captionRaster(cue, captions.style);
            if (raster.image)
              ui.programCtx.drawImage(raster.image, 0, 0, width, height);
            else {
              textPending = true;
              textError = raster.error;
            }
          }
      ui.$('preview-empty').hidden ||= (ui.project.timeline.titles ?? []).some((t) => ui.playhead >= t.start && ui.playhead < t.end) || !!(captions?.enabled && captions.cues.some((cue) => ui.playhead * 1000 >= cue.startMs && ui.playhead * 1000 < cue.endMs));
      ui.$('preview-quality').textContent = textError ?? (textPending ? 'Rendering text…' : approximation ? 'Spatial approximation' : 'Shared CPU preview');
      ui.$('preview-note').textContent = unknown ? 'Unsupported enabled effect: export will refuse this stack.' : approximation ? 'Blur uses browser Gaussian; sharpen uses RGB spatial processing. Export uses FFmpeg kernels.' : 'Shared RGB, clip-local keyframes & fade envelopes · AV tracks are separate';
    }
    catch (error) {
      ui.$('preview-note').textContent = 'Preview error: ' + error.message;
    }
    finally {
      ui.applying = false;
    }
  }
  Object.assign(ui, { overlayRaster, titleRaster, captionRaster, discard, syncPreview, spatialSharpen, drawProgram });
}
