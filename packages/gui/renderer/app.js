import { evaluateTransform, evaluateAnimatable, EASINGS } from '@freemier/shared/animation';
import { EFFECT_CATALOG, createColorProcessor, fadeEnvelope } from '@freemier/shared/effects';
import { frameTimecode, parseFrameTimecode } from '@freemier/shared/timecode';

const BRIDGE = 'http://127.0.0.1:' + (new URLSearchParams(location.search).get('bridge') ?? '4317');
const api = window.freemier ?? window.palmier;
const $ = (id) => document.getElementById(id);
let project = null, revision = -1, playhead = 0, playing = false, selectedClipId = null;
let workspace = 'edit', browser = 'project', tool = 'select', snap = true, pps = 90, grid = true;
let eventEpoch = null, eventSequence = -1;
let sourceAssetId = null, sourceHead = 0, sourceIn = 0, sourceOut = 0, sourcePlaying = false, sourceEl = null;
let targetTrackId = null, sourceFocused = false, audioContext = null, applying = false;
const decoders = new Map(), thumbs = new Map(), pendingThumbs = new Map(), waveforms = new Map();
const pixelProcessors = new Map(), scratch = document.createElement('canvas'), scratch2 = document.createElement('canvas');
const program = $('program-canvas'), programCtx = program.getContext('2d', { willReadFrequently: true });
const canvas = $('timeline'), ctx = canvas.getContext('2d');
const TRACK_H = 62, RULER_H = 28;
const fps = () => project?.timeline.fps ?? 30;
const q = (t) => Math.round(t * fps()) / fps();
const tracks = () => [...(project?.timeline.tracks ?? [])].sort((a, b) => b.order - a.order);
const duration = () => Math.max(0, ...(project?.timeline.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)) ?? []));
const viewEnd = () => Math.max(duration(), ...(project?.timeline.markers ?? []).map((m) => m.time));
const find = (id = selectedClipId) => { for (const track of project?.timeline.tracks ?? []) { const clip = track.clips.find((c) => c.id === id); if (clip) return { track, clip }; } return null; };
const assetFor = (clip) => project?.media.find((m) => m.id === clip.assetId);
const mediaUrl = (asset) => BRIDGE + '/media/' + encodeURIComponent(asset.id);
const local = (clip) => Math.max(0, Math.min(clip.duration, playhead - clip.start));
function tc(seconds, rate = fps()) {
  return frameTimecode(seconds, rate);
}
function toast(message, kind = '') { $('toast').textContent = message; $('toast').className = 'toast show ' + kind; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').className = 'toast', 3200); }
function node(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
function button(text, title, onClick, cls = '') { const el = node('button', cls, text); el.title = title; el.addEventListener('click', onClick); return el; }
async function command(action, args = {}) {
  try {
    const result = await (await fetch(BRIDGE + '/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) })).json();
    if (!result.ok) throw new Error(result.error?.message ?? 'Command failed');
    if (result._bridge) applyState(result._bridge.project, result._bridge.revision, result._bridge);
    return result;
  } catch (error) { toast(error.message, 'error'); return null; }
}
function setHead(t, inspector = true) {
  playhead = q(Math.max(0, Math.min(viewEnd(), t))); updateTransport(); syncPreview(); renderTimeline(); if (inspector) renderInspector();
  const scroll = $('timeline-scroll'), x = playhead * pps;
  if (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - 8) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
}
function select(id) { selectedClipId = id; renderInspector(); renderTimeline(); }
function applyState(next, nextRevision, history = {}) {
  if (!next?.timeline) return;
  if (history.eventEpoch !== undefined && history.eventSequence !== undefined) {
    if (eventEpoch === history.eventEpoch && history.eventSequence <= eventSequence && project) return;
    eventEpoch = history.eventEpoch; eventSequence = history.eventSequence;
  }
  const replace = project?.id !== next.id;
  project = next; revision = nextRevision ?? revision;
  if (replace) { selectedClipId = null; playhead = 0; playing = false; sourcePlaying = false; sourceAssetId = null; sourceEl?.pause?.(); $('source-stage').querySelectorAll('video,audio,img').forEach((el) => el.remove()); sourceEl = null; thumbs.clear(); pendingThumbs.clear(); waveforms.clear(); }
  playhead = Math.min(playhead, viewEnd());
  if (!find()) selectedClipId = null;
  $('project-name').textContent = next.name; $('sequence-name').textContent = next.timeline.name ?? 'Sequence';
  $('project-format').textContent = next.timeline.width + ' × ' + next.timeline.height + ' · ' + next.timeline.fps + ' fps';
  $('revision').textContent = 'rev ' + revision;
  $('btn-undo').disabled = history.canUndo === false; $('btn-redo').disabled = history.canRedo === false;
  renderMediaBin(); renderTrackHeaders(); renderTimeline(); renderInspector(); syncPreview(); updateTransport(); updateSource(); report();
}
function report() {
  api?.reportState?.({ revision, projectName: project?.name, mediaCount: project?.media.length ?? 0, clipCount: project?.timeline.tracks.reduce((n, t) => n + t.clips.length, 0) ?? 0, trackCount: project?.timeline.tracks.length ?? 0, duration: duration(), mediaItemsRendered: $('media-bin').querySelectorAll('.media-item').length, previewVideos: $('preview-stage').querySelectorAll('video').length, lastRenderedAt: Date.now() });
}
function connect() {
  const source = new EventSource(BRIDGE + '/events');
  source.onopen = () => { $('live-status').className = 'live-status on'; $('live-text').textContent = 'Live MCP'; };
  source.onerror = () => { $('live-status').className = 'live-status off'; $('live-text').textContent = 'Reconnecting'; };
  source.onmessage = ({ data }) => {
    let event; try { event = JSON.parse(data); } catch { return; }
    // SSE is ordered. Undo restores an earlier snapshot revision and must repaint.
    if (event.type === 'snapshot' || event.type === 'change') applyState(event.state.project ?? event.state, event.revision, event.state);
    else if (event.type === 'export-progress') showProgress(event.fraction);
  };
}

// Project bin and source monitor stay independent of sequence selection.
function renderMediaBin() {
  if (!project) return;
  const query = $('bin-search').value.toLowerCase();
  $('media-bin').hidden = browser !== 'project'; $('effects-browser').hidden = browser !== 'effects';
  $('markers-panel').hidden = browser !== 'markers';
  $('bin-search').placeholder = browser === 'project' ? 'Search media' : browser === 'effects' ? 'Search effects' : 'Search markers';
  $('bin-search').setAttribute('aria-label', $('bin-search').placeholder);
  $('media-bin').className = 'media-bin ' + (grid ? 'grid' : 'list');
  const assets = project.media.filter((a) => a.name.toLowerCase().includes(query));
  $('bin-count').textContent = (browser === 'project' ? assets.length : browser === 'effects' ? EFFECT_CATALOG.filter((e) => e.name.toLowerCase().includes(query)).length : (project.timeline.markers ?? []).filter((m) => (m.label + ' ' + m.notes).toLowerCase().includes(query)).length) + ' items';
  renderMarkers(query);
  $('media-bin').replaceChildren(...assets.map((asset) => {
    const item = node('div', 'media-item' + (asset.id === sourceAssetId ? ' selected' : '')); item.dataset.assetId = asset.id; item.draggable = true; item.tabIndex = 0;
    const img = node('img', 'media-thumb'); img.alt = asset.name; if (thumbs.has(asset.id)) img.src = thumbs.get(asset.id); else void thumbnail(asset, img);
    const meta = node('div', 'media-meta'); meta.append(node('div', 'media-name', asset.name), node('div', 'media-sub', tc(asset.duration) + ' · ' + asset.kind.toUpperCase()));
    item.append(img, meta); item.addEventListener('dblclick', () => openSource(asset.id)); item.addEventListener('keydown', (e) => { if (e.key === 'Enter') openSource(asset.id); });
    item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-freemier-asset', asset.id); e.dataTransfer.setData('text/plain', asset.id); e.dataTransfer.effectAllowed = 'copy'; }); return item;
  }));
  if (!assets.length) $('media-bin').append(node('div', 'empty', 'Import media to begin. Double-click a tile to inspect its source; drag it onto a track to edit.'));
  $('effects-browser').replaceChildren();
  for (const kind of ['video', 'audio']) {
    const matches = EFFECT_CATALOG.filter((e) => e.media === kind && e.name.toLowerCase().includes(query));
    if (!matches.length) continue;
    $('effects-browser').append(node('div', 'effect-category', kind + ' effects'));
    for (const effect of matches) {
      const tile = button('', 'Add ' + effect.name + ' to the selected matching clip', () => addSelectedEffect(effect.type), 'effect-tile'); tile.dataset.effectType = effect.type;
      const label = node('div', '', effect.name); label.append(node('small', '', effect.preview === 'envelope' ? 'Clip-local envelope' : effect.type === 'blur' || effect.type === 'sharpen' ? 'CPU · spatial preview approximation' : 'CPU · shared RGB processing'));
      tile.append(node('span', 'effect-icon', 'fx'), label); $('effects-browser').append(tile);
    }
  }
}
function renderMarkers(query = '') {
  const list = $('marker-list'); list.replaceChildren();
  for (const marker of (project?.timeline.markers ?? []).filter((m) => (m.label + ' ' + m.notes).toLowerCase().includes(query))) {
    const row = node('div', 'marker-card'); row.dataset.markerId = marker.id; row.style.borderLeftColor = marker.color;
    const title = node('div', 'marker-card-head'), jump = button(tc(marker.time), 'Seek marker ' + marker.label, () => setHead(marker.time)); jump.dataset.markerJump = marker.id;
    const remove = button('×', 'Delete marker ' + marker.label, () => command('marker_remove', { markerId: marker.id })); remove.dataset.markerRemove = marker.id; title.append(jump, remove);
    const label = node('input'); label.value = marker.label; label.maxLength = 120; label.setAttribute('aria-label', 'Marker label ' + marker.id); label.addEventListener('change', () => command('marker_update', { markerId: marker.id, label: label.value }));
    const color = node('input'); color.type = 'color'; color.value = marker.color; color.setAttribute('aria-label', 'Marker color ' + marker.id); color.addEventListener('change', () => command('marker_update', { markerId: marker.id, color: color.value }));
    const notes = node('textarea'); notes.rows = 2; notes.maxLength = 4096; notes.value = marker.notes; notes.placeholder = 'Notes'; notes.setAttribute('aria-label', 'Marker notes ' + marker.id); notes.addEventListener('change', () => command('marker_update', { markerId: marker.id, notes: notes.value }));
    row.append(title, label, color); numericControl(row, 'Time (seconds)', marker.time, 0, 86400, 1 / fps(), (time) => command('marker_update', { markerId: marker.id, time })); row.append(notes); list.append(row);
  }
  if (!list.children.length) list.append(node('div', 'empty', 'Add a marker at the playhead. M adds a point; the arrow controls navigate points.'));
}
async function addAtHead() { await command('marker_add', { time: playhead, label: $('marker-label').value.trim() || 'Marker ' + tc(playhead) }); }
function navigateMarker(direction) {
  const ordered = [...(project?.timeline.markers ?? [])].sort((a, b) => a.time - b.time);
  const marker = direction > 0 ? ordered.find((m) => m.time > playhead + 1e-6) : ordered.filter((m) => m.time < playhead - 1e-6).at(-1);
  if (marker) setHead(marker.time);
}
async function thumbnail(asset, img) {
  try {
    if (asset.kind === 'audio') return;
    if (asset.kind === 'image') { img.crossOrigin = 'anonymous'; img.src = mediaUrl(asset); thumbs.set(asset.id, img.src); return; }
    if (!pendingThumbs.has(asset.id)) pendingThumbs.set(asset.id, fetch(BRIDGE + '/thumbnail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: asset.id }) }).then((r) => r.json()));
    const result = await pendingThumbs.get(asset.id); if (result.ok) { thumbs.set(asset.id, result.dataUrl); img.src = result.dataUrl; }
  } catch {}
}
function openSource(id) {
  const asset = project?.media.find((a) => a.id === id); if (!asset) return;
  sourceEl?.pause?.(); $('source-stage').querySelectorAll('video,audio,img').forEach((el) => el.remove());
  sourceAssetId = id; sourceHead = sourceIn = 0; sourceOut = asset.duration; sourcePlaying = false;
  sourceEl = node(asset.kind === 'image' ? 'img' : asset.kind === 'audio' ? 'audio' : 'video'); sourceEl.crossOrigin = 'anonymous'; sourceEl.src = mediaUrl(asset); sourceEl.preload = 'auto';
  sourceEl.dataset.assetId = id; sourceEl.addEventListener('loadeddata', updateSource); sourceEl.addEventListener('load', updateSource); $('source-stage').append(sourceEl);
  sourceFocused = true; renderMediaBin(); updateSource();
}
function updateSource() {
  const asset = project?.media.find((a) => a.id === sourceAssetId);
  $('source-empty').hidden = !!asset; $('source-name').textContent = asset?.name ?? 'No selection'; $('source-timecode').textContent = tc(sourceHead);
  $('source-range').textContent = asset ? 'I ' + tc(sourceIn) + ' · O ' + tc(sourceOut) : 'No in / out';
  $('source-scrub').value = String(asset?.duration ? sourceHead / asset.duration * 1000 : 0); $('source-play').textContent = sourcePlaying ? '❚❚' : '▶';
  if (asset && sourceEl && asset.kind !== 'image') {
    if (Math.abs(sourceEl.currentTime - sourceHead) > (sourcePlaying ? .12 : .001)) try { sourceEl.currentTime = sourceHead; } catch {}
    if (sourcePlaying) sourceEl.play().catch(() => {}); else sourceEl.pause();
  }
}
function sourceSeek(t) { const asset = project?.media.find((a) => a.id === sourceAssetId); if (!asset) return; sourceHead = q(Math.max(0, Math.min(asset.duration, t))); updateSource(); }
async function placeSource() {
  const asset = project?.media.find((a) => a.id === sourceAssetId), trackId = $('source-track').value;
  if (!asset) { toast('Open a source first', 'error'); return; }
  const mode = $('source-placement').value, args = { assetId: asset.id, trackId, sourceIn, duration: sourceOut - sourceIn, strict: mode === 'strict', ripple: mode === 'ripple' };
  if (mode !== 'append') args.start = playhead;
  const result = await command('clip_add', args); if (result) { select(result.clip.id); setHead(result.clip.start); toast('Placed ' + asset.name); }
}

// Actual media decoders + Web Audio gain, with one decoder per clip.
function audioBus(el) {
  audioContext ??= new AudioContext(); const source = audioContext.createMediaElementSource(el), gain = audioContext.createGain(), analyser = audioContext.createAnalyser();
  analyser.fftSize = 256; source.connect(gain); gain.connect(analyser); analyser.connect(audioContext.destination); return { source, gain, analyser };
}
function discard(entry) { if (entry.frameRequest !== undefined) entry.el.cancelVideoFrameCallback(entry.frameRequest); entry.el.pause?.(); entry.el.remove(); entry.source?.disconnect(); entry.gain?.disconnect(); entry.analyser?.disconnect(); }
function syncPreview() {
  if (!project) return;
  const active = [];
  for (const track of [...project.timeline.tracks].sort((a, b) => a.order - b.order)) if (!track.muted) for (const clip of track.clips) if (playhead >= clip.start - 1e-6 && playhead < clip.start + clip.duration - 1e-6) active.push({ clip, track, asset: assetFor(clip) });
  const wanted = new Set(active.map(({ clip }) => clip.id));
  for (const [id, entry] of decoders) if (!wanted.has(id)) { discard(entry); decoders.delete(id); }
  for (const { clip, track, asset } of active) {
    if (!asset) continue;
    const tag = asset.kind === 'image' ? 'IMG' : track.kind === 'audio' || asset.kind === 'audio' ? 'AUDIO' : 'VIDEO';
    let entry = decoders.get(clip.id);
    if (entry && (entry.el.tagName !== tag || entry.el.src !== mediaUrl(asset))) { discard(entry); decoders.delete(clip.id); entry = null; }
    if (!entry) {
      const el = node(tag.toLowerCase()); el.crossOrigin = 'anonymous'; el.src = mediaUrl(asset); el.dataset.clipId = clip.id; el.preload = 'auto'; el.muted = track.kind === 'video'; el.volume = 1;
      entry = { el, ...(tag === 'AUDIO' && asset.hasAudio ? audioBus(el) : {}) }; decoders.set(clip.id, entry); $('preview-stage').append(el);
      el.addEventListener('loadeddata', () => { drawProgram(); report(); }); el.addEventListener('seeked', drawProgram); el.addEventListener('load', drawProgram);
      if (tag === 'VIDEO') {
        const presented = () => {
          if (decoders.get(clip.id) !== entry) return;
          drawProgram(); entry.frameRequest = el.requestVideoFrameCallback(presented);
        };
        entry.frameRequest = el.requestVideoFrameCallback(presented);
      }
    }
    const sourceTime = clip.sourceIn + playhead - clip.start, el = entry.el;
    if (tag !== 'IMG' && Math.abs(el.currentTime - sourceTime) > (playing ? .12 : .001)) try { el.currentTime = Math.max(0, sourceTime); } catch {}
    const transform = evaluateTransform(clip.transform, local(clip)); el.dataset.transform = JSON.stringify(transform);
    el.style.transform = 'translate(' + transform.x * program.width + 'px, ' + transform.y * program.height + 'px) scale(' + transform.scale + ') rotate(' + transform.rotation + 'deg)';
    el.style.opacity = String(transform.opacity);
    let gain = clip.volume; for (const effect of clip.effects) if (effect.enabled && effect.type === 'audio_fade') gain *= fadeEnvelope(effect, local(clip));
    if (entry.gain) { entry.gain.gain.value = gain; el.dataset.gain = String(gain); }
    if (tag !== 'IMG') { if (playing) el.play().catch(() => {}); else el.pause(); }
  }
  $('preview-stage').dataset.activeClips = String(active.length); $('preview-empty').hidden = active.some((a) => a.track.kind === 'video' && a.asset?.kind !== 'audio');
  drawProgram();
}
function spatialSharpen(context, width, height, amount) {
  const image = context.getImageData(0, 0, width, height), data = image.data, original = new Uint8ClampedArray(data), kernel = [1, 4, 6, 4, 1];
  // Real spatial processing; RGB kernel approximation of export's luma unsharp.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < 3; channel++) {
    let blurred = 0;
    for (let ky = -2; ky <= 2; ky++) for (let kx = -2; kx <= 2; kx++) { const sx = Math.max(0, Math.min(width - 1, x + kx)), sy = Math.max(0, Math.min(height - 1, y + ky)); blurred += original[(sy * width + sx) * 4 + channel] * kernel[kx + 2] * kernel[ky + 2] / 256; }
    const index = (y * width + x) * 4 + channel; data[index] = original[index] + amount * (original[index] - blurred);
  }
  context.putImageData(image, 0, 0);
}
function drawProgram() {
  if (!project || applying) return;
  applying = true;
  try {
    const stage = $('preview-stage'), aspect = project.timeline.width / project.timeline.height;
    const width = Math.max(2, Math.round(Math.min(stage.clientWidth, stage.clientHeight * aspect))), height = Math.max(2, Math.round(width / aspect));
    if (program.width !== width || program.height !== height) { program.width = scratch.width = scratch2.width = width; program.height = scratch.height = scratch2.height = height; }
    programCtx.fillStyle = '#000'; programCtx.fillRect(0, 0, width, height);
    const sc = scratch.getContext('2d', { willReadFrequently: true }), aux = scratch2.getContext('2d');
    let approximation = false, unknown = false;
    for (const track of [...project.timeline.tracks].sort((a, b) => a.order - b.order)) if (track.kind === 'video' && !track.muted) for (const clip of track.clips) {
      const el = decoders.get(clip.id)?.el, asset = assetFor(clip); if (!el || !asset || el.tagName === 'AUDIO' || (el.tagName === 'VIDEO' ? el.readyState < 2 : !el.complete)) continue;
      sc.clearRect(0, 0, width, height); const iw = el.videoWidth || el.naturalWidth, ih = el.videoHeight || el.naturalHeight; if (!iw || !ih) continue;
      const fit = Math.min(width / iw, height / ih); sc.drawImage(el, (width - iw * fit) / 2, (height - ih * fit) / 2, iw * fit, ih * fit);
      let envelope = 1;
      for (const effect of clip.effects) {
        if (!effect.enabled) continue;
        if (['color_adjust', 'grayscale', 'sepia'].includes(effect.type)) {
          const cacheKey = effect.type + JSON.stringify(effect.params); if (!pixelProcessors.has(cacheKey)) { if (pixelProcessors.size > 100) pixelProcessors.clear(); pixelProcessors.set(cacheKey, createColorProcessor(effect.type, effect.params)); }
          const process = pixelProcessors.get(cacheKey), image = sc.getImageData(0, 0, width, height), data = image.data;
          for (let i = 0; i < data.length; i += 4) { const rgb = process([data[i], data[i + 1], data[i + 2]]); data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; }
          sc.putImageData(image, 0, 0);
        } else if (effect.type === 'blur') { approximation = true; aux.clearRect(0, 0, width, height); aux.filter = 'blur(' + Number(effect.params.radius) * width / project.timeline.width + 'px)'; aux.drawImage(scratch, 0, 0); aux.filter = 'none'; sc.clearRect(0, 0, width, height); sc.drawImage(scratch2, 0, 0); }
        else if (effect.type === 'sharpen') { approximation = true; spatialSharpen(sc, width, height, Number(effect.params.amount)); }
        else if (effect.type === 'video_fade') envelope *= fadeEnvelope(effect, local(clip));
        else if (effect.type !== 'audio_fade') unknown = true;
      }
      const t = evaluateTransform(clip.transform, local(clip)); programCtx.save(); programCtx.globalAlpha = t.opacity * envelope;
      programCtx.translate(width / 2 + t.x * width, height / 2 + t.y * height); programCtx.rotate(t.rotation * Math.PI / 180); programCtx.scale(t.scale, t.scale);
      programCtx.drawImage(scratch, -width / 2, -height / 2); programCtx.restore();
    }
    $('preview-quality').textContent = approximation ? 'Spatial approximation' : 'Shared CPU preview';
    $('preview-note').textContent = unknown ? 'Unsupported enabled effect: export will refuse this stack.' : approximation ? 'Blur uses browser Gaussian; sharpen uses RGB spatial processing. Export uses FFmpeg kernels.' : 'Shared RGB, clip-local keyframes & fade envelopes · AV tracks are separate';
  } catch (error) { $('preview-note').textContent = 'Preview error: ' + error.message; }
  finally { applying = false; }
}

// Inspector edits are commits through validated bridge contracts, never local project mutations.
function heading(text) { const el = node('div', 'section-label', text); $('inspector').append(el); return el; }
function numericControl(parent, label, value, min, max, step, commit, extra) {
  const row = node('div', 'control-row'), name = node('label', '', label), input = node('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.value = Number(value.toFixed(4)); input.setAttribute('aria-label', label);
  input.addEventListener('change', () => commit(Number(input.value))); row.append(name, input); if (extra) row.append(extra); parent.append(row); return input;
}
async function addSelectedEffect(type) {
  const sel = find(); if (!sel) { toast('Select a clip to add an effect', 'error'); return; }
  const descriptor = EFFECT_CATALOG.find((e) => e.type === type), params = {};
  if (type.endsWith('_fade')) params.duration = Math.min(1, sel.clip.duration);
  if (descriptor?.media !== sel.track.kind) { toast('Select a ' + descriptor?.media + ' clip on a ' + descriptor?.media + ' track', 'error'); return; }
  await command('effect_add', { clipId: sel.clip.id, type, params });
}
function renderInspector() {
  const panel = $('inspector'); panel.replaceChildren(); const sel = find();
  $('inspector-title').textContent = workspace === 'color' ? 'Color controls' : workspace === 'audio' ? 'Audio mix' : 'Effect controls';
  $('selection-kind').textContent = sel?.track.kind.toUpperCase() ?? 'SEQUENCE';
  $('selection-info').textContent = sel ? (sel.clip.label ?? assetFor(sel.clip)?.name ?? 'Clip') + ' · ' + tc(sel.clip.duration) : 'No clip selected';
  if (!sel) { panel.append(node('div', 'empty', 'Select a timeline clip. Every control edits the same project as your MCP client.')); return; }
  const { clip, track } = sel, time = local(clip);
  panel.append(node('div', 'selection-heading', clip.label ?? assetFor(clip)?.name ?? 'Clip'), node('div', 'clip-summary', track.name + ' · ' + tc(clip.start) + ' → ' + tc(clip.start + clip.duration) + '\nSource ' + tc(clip.sourceIn) + ' → ' + tc(clip.sourceOut)));
  if (track.locked) panel.append(node('div', 'inspector-note', 'Track is locked. Unlock its header to edit content.'));
  if (workspace === 'edit' && track.kind === 'video') {
    heading('Motion · local ' + tc(time)); const transform = evaluateTransform(clip.transform, time);
    const specs = [['Scale', 'scale', .01, 10, .01], ['Position X', 'x', -10, 10, .01], ['Position Y', 'y', -10, 10, .01], ['Rotation', 'rotation', -36000, 36000, 1], ['Opacity', 'opacity', 0, 1, .01]];
    for (const [label, property, min, max, step] of specs) {
      const curve = clip.transform[property], existing = curve.keyframes.find((k) => Math.abs(k.time - q(time)) < 1e-6);
      const key = button('◆', existing ? 'Remove keyframe at playhead' : 'Add keyframe at playhead', () => command(existing ? 'keyframe_remove' : 'keyframe_set', { clipId: clip.id, property, time: q(time), ...(existing ? {} : { value: transform[property] }) }), 'key-button' + (curve.keyframes.length ? ' keyed' : ''));
      key.dataset.keyProperty = property;
      numericControl(panel, label, transform[property], min, max, step, (value) => command(curve.keyframes.length ? 'keyframe_set' : 'clip_set_transform', { clipId: clip.id, ...(curve.keyframes.length ? { property, time: q(time), value } : { [property]: value }) }), key);
    }
    const section = heading('Keyframes'); const choice = node('select'); choice.setAttribute('aria-label', 'Keyframe property'); for (const property of ['x', 'y', 'scale', 'rotation', 'opacity']) { const opt = node('option', '', property); opt.value = property; choice.append(opt); }
    choice.value = renderInspector.keyProperty ?? 'opacity'; section.append(choice);
    choice.addEventListener('change', () => { renderInspector.keyProperty = choice.value; renderInspector(); });
    const property = choice.value, curve = clip.transform[property], plot = node('canvas', 'curve'); plot.width = 260; plot.height = 64; plot.dataset.property = property; panel.append(plot); drawCurve(plot, curve, clip.duration, time);
    const list = node('div', 'key-list'); for (const key of curve.keyframes) {
      const row = node('div', 'key-row'), value = node('input'), easing = node('select'); value.type = 'number'; value.value = key.value; value.setAttribute('aria-label', 'Keyframe value at ' + key.time);
      for (const e of EASINGS) { const opt = node('option', '', e); opt.value = e; easing.append(opt); } easing.value = key.easing; easing.setAttribute('aria-label', 'Keyframe easing at ' + key.time);
      const update = () => command('keyframe_set', { clipId: clip.id, property, time: key.time, value: Number(value.value), easing: easing.value }); value.addEventListener('change', update); easing.addEventListener('change', update);
      row.append(button(tc(key.time), 'Seek keyframe', () => setHead(clip.start + key.time)), value, easing, button('×', 'Remove keyframe', () => command('keyframe_remove', { clipId: clip.id, property, time: key.time }))); list.append(row);
    }
    panel.append(list);
  }
  if (workspace === 'audio' || track.kind === 'audio') {
    heading('Gain'); if (track.kind === 'audio') {
      numericControl(panel, 'Volume', clip.volume, 0, 4, .01, (volume) => command('clip_set_audio', { clipId: clip.id, volume }));
      const meter = node('div', 'meter'), fill = node('div', 'meter-fill'); fill.id = 'audio-meter-fill'; meter.append(fill); const label = node('div', 'meter-label', 'RMS −∞ dBFS · decoded output'); label.id = 'audio-meter-label'; panel.append(meter, label);
    } else panel.append(node('div', 'inspector-note', 'Audio is mixed from audio tracks. Place the source on an audio track to hear or edit its gain.'));
  }
  heading(workspace === 'color' ? 'Color stack' : 'Effects stack');
  if (workspace === 'color' && track.kind === 'video') panel.append(button('＋ Color adjustment', 'Add a real RGB color adjustment', () => addSelectedEffect('color_adjust'), 'accent'));
  const effects = clip.effects.filter((effect) => workspace === 'color' ? ['color_adjust', 'grayscale', 'sepia'].includes(effect.type) : workspace === 'audio' ? effect.type === 'audio_fade' : true);
  for (const effect of effects) {
    const descriptor = EFFECT_CATALOG.find((e) => e.type === effect.type), card = node('div', 'effect-card'); card.dataset.effectId = effect.id; card.dataset.effectType = effect.type;
    const head = node('header'), toggle = node('input'); toggle.type = 'checkbox'; toggle.checked = effect.enabled; toggle.setAttribute('aria-label', 'Enable ' + effect.type); toggle.addEventListener('change', () => command('effect_update', { clipId: clip.id, effectId: effect.id, enabled: toggle.checked }));
    head.append(toggle, node('span', '', descriptor?.name ?? effect.type), button('×', 'Remove effect', () => command('effect_remove', { clipId: clip.id, effectId: effect.id }))); card.append(head);
    for (const [name, schema] of Object.entries(descriptor?.params ?? {})) {
      if (schema.type === 'number') numericControl(card, name, Number(effect.params[name] ?? schema.default), schema.min, schema.max, .01, (value) => command('effect_update', { clipId: clip.id, effectId: effect.id, params: { [name]: value } }));
      else { const row = node('div', 'control-row'), select = node('select'); for (const value of schema.choices) { const opt = node('option', '', value); opt.value = value; select.append(opt); } select.value = effect.params[name] ?? schema.default; select.setAttribute('aria-label', name); select.addEventListener('change', () => command('effect_update', { clipId: clip.id, effectId: effect.id, params: { [name]: select.value } })); row.append(node('label', '', name), select); card.append(row); }
    }
    if (effect.type === 'blur' || effect.type === 'sharpen') card.append(node('div', 'inspector-note', 'Live spatial kernel is an approximation. Export uses FFmpeg.'));
    if (!descriptor) card.append(node('div', 'inspector-note', 'Unsupported effect. Remove or disable before export.'));
    panel.append(card);
  }
  if (!effects.length) panel.append(node('div', 'inspector-note', 'Choose an effect from the Effects browser.'));
  if (Object.values(clip.transform).some((p) => p.keyframes.length) || clip.effects.some((e) => e.enabled && e.type.endsWith('_fade'))) panel.append(node('div', 'inspector-note', 'Animated/fading clips: split and head trim cannot rebase curves yet. Moving/slipping/duplicating preserves local animation; unsupported boundary edits return an error.'));
}
function drawCurve(plot, curve, length, time) {
  const c = plot.getContext('2d'), values = [curve.value, ...curve.keyframes.map((k) => k.value)], min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const x = (t) => t / length * 250 + 5, y = (v) => 54 - (v - min) / range * 44;
  c.strokeStyle = '#353b49'; for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(0, i * 16); c.lineTo(260, i * 16); c.stroke(); }
  c.strokeStyle = '#b19bec'; c.beginPath(); for (let i = 0; i <= 250; i++) { const v = evaluateAnimatable(curve, i / 250 * length); if (i) c.lineTo(i + 5, y(v)); else c.moveTo(5, y(v)); } c.stroke();
  c.fillStyle = '#d2bfff'; for (const key of curve.keyframes) { c.beginPath(); c.arc(x(key.time), y(key.value), 3, 0, Math.PI * 2); c.fill(); }
  c.strokeStyle = '#f0a35e'; c.beginPath(); c.moveTo(x(time), 0); c.lineTo(x(time), 64); c.stroke();
}

// Dense timeline: scroll/zoom, clip thumbnails/waveforms, track controls and actual edit gestures.
function renderTrackHeaders() {
  $('track-headers').replaceChildren();
  for (const track of tracks()) {
    const row = node('div', 'track-header' + (track.id === targetTrackId ? ' selected' : '')); row.dataset.trackId = track.id;
    const name = button(track.name, 'Target source placement to ' + track.name, () => { targetTrackId = track.id; renderTrackHeaders(); }, 'track-name');
    const mute = button('M', 'Mute ' + track.name, () => command('track_update', { trackId: track.id, muted: !track.muted }), track.muted ? 'active' : ''); mute.dataset.trackMute = track.id;
    const lock = button(track.locked ? '◆' : '◇', 'Lock / unlock ' + track.name, () => command('track_update', { trackId: track.id, locked: !track.locked }), track.locked ? 'active' : ''); lock.dataset.trackLock = track.id;
    row.append(name, mute, lock, node('span', 'track-kind', track.kind.toUpperCase() + (track.locked ? ' · LOCKED' : ''))); $('track-headers').append(row);
  }
  const tail = node('div'); tail.style.height = '24px'; $('track-headers').append(tail); $('track-headers').scrollTop = $('timeline-scroll').scrollTop;
  const chosen = targetTrackId ?? $('source-track').value;
  $('source-track').replaceChildren(...tracks().map((track) => { const opt = node('option', '', track.name + (track.locked ? ' 🔒' : '')); opt.value = track.id; return opt; }));
  if (project.timeline.tracks.some((t) => t.id === chosen)) $('source-track').value = chosen; targetTrackId = $('source-track').value;
}
function renderTimeline() {
  if (!project) return;
  const scroll = $('timeline-scroll'), dpr = devicePixelRatio || 1, ordered = tracks();
  const width = Math.max(scroll.clientWidth, Math.max(10, viewEnd() + 2) * pps), height = Math.max(ordered.length * TRACK_H + RULER_H + 24, scroll.clientHeight);
  $('timeline-area').style.width = width + 'px'; $('timeline-area').style.height = height + 'px';
  const visibleWidth = Math.max(1, scroll.clientWidth), visibleHeight = Math.max(1, scroll.clientHeight), offsetX = scroll.scrollLeft, offsetY = scroll.scrollTop;
  canvas.style.width = visibleWidth + 'px'; canvas.style.height = visibleHeight + 'px'; canvas.width = Math.round(visibleWidth * dpr); canvas.height = Math.round(visibleHeight * dpr); ctx.setTransform(dpr, 0, 0, dpr, -offsetX * dpr, -offsetY * dpr);
  canvas._xOf = (t) => t * pps; canvas._tOf = (x) => (x + scroll.scrollLeft) / pps; canvas.dataset.trackHeight = TRACK_H; canvas.dataset.rulerHeight = RULER_H; canvas.dataset.pps = pps;
  canvas.dataset.waveformPeaks = [...waveforms.values()].reduce((n, peaks) => n + peaks.length, 0);
  ctx.fillStyle = '#1a1c21'; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#282b33'; ctx.fillRect(0, 0, width, RULER_H);
  let step = .1; while (step * pps < 70) step = step < 1 ? step * 2 : step < 2 ? 2 : step < 5 ? 5 : step * 2;
  ctx.font = '9px ui-monospace,monospace'; ctx.textBaseline = 'middle';
  for (let t = Math.floor(offsetX / pps / step) * step; t * pps <= offsetX + visibleWidth; t += step) { const x = t * pps; ctx.strokeStyle = '#2f333d'; ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, height); ctx.stroke(); ctx.fillStyle = '#7c859a'; ctx.fillText(tc(t), x + 5, 13); }
  for (const marker of project.timeline.markers ?? []) { const x = marker.time * pps; if (x < offsetX - 8 || x > offsetX + visibleWidth + 8) continue; ctx.fillStyle = marker.color; ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x + 5, 13); ctx.lineTo(x, 18); ctx.lineTo(x - 5, 13); ctx.closePath(); ctx.fill(); }
  for (let i = 0; i < ordered.length; i++) {
    const track = ordered[i], y = RULER_H + i * TRACK_H; if (y + TRACK_H < offsetY || y > offsetY + visibleHeight) continue; ctx.fillStyle = track.kind === 'audio' ? '#1d2525' : '#1e222a'; ctx.fillRect(0, y, width, TRACK_H - 1);
    for (const clip of track.clips) {
      const x = clip.start * pps, w = Math.max(2, clip.duration * pps), h = TRACK_H - 10, asset = assetFor(clip), selected = clip.id === selectedClipId;
      if (x + w < offsetX || x > offsetX + visibleWidth) continue;
      ctx.globalAlpha = track.muted ? .4 : 1; ctx.fillStyle = track.kind === 'video' ? '#3b6ea5' : '#3f7a68'; ctx.fillRect(x + 1, y + 4, w - 2, h);
      ctx.fillStyle = track.kind === 'video' ? '#446784' : '#456f62'; ctx.fillRect(x + 1, y + 4, w - 2, 16);
      if (track.kind === 'audio') { if (asset?.hasAudio && !waveforms.has(asset.id)) { waveforms.set(asset.id, []); fetch(BRIDGE + '/waveform', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: asset.id }) }).then((r) => r.json()).then((result) => { if (result.ok) waveforms.set(asset.id, result.peaks); renderTimeline(); }).catch(() => {}); }
        const peaks = waveforms.get(asset?.id) ?? []; ctx.strokeStyle = '#99c8b5'; ctx.beginPath();
        for (let px = x + 3; px < x + w - 3; px += 2) { const source = clip.sourceIn + (px - x) / pps, peak = peaks[Math.min(peaks.length - 1, Math.floor(source / (asset?.duration || 1) * peaks.length))] ?? 0, ph = Math.min(1, peak * clip.volume) * 25; ctx.moveTo(px, y + 38 - ph / 2); ctx.lineTo(px, y + 38 + ph / 2); } ctx.stroke();
      } else if (thumbs.has(asset?.id)) {
        const cacheKey = 'image:' + asset.id; if (!thumbs.has(cacheKey)) { const image = new Image(); image.src = thumbs.get(asset.id); image.onload = renderTimeline; thumbs.set(cacheKey, image); }
        const image = thumbs.get(cacheKey); if (image.complete && image.naturalWidth) { ctx.save(); ctx.beginPath(); ctx.rect(x + 2, y + 21, w - 4, 32); ctx.clip(); ctx.globalAlpha = track.muted ? .3 : .75; for (let px = x + 2; px < x + w; px += 57) ctx.drawImage(image, px, y + 21, 57, 32); ctx.restore(); }
      }
      ctx.fillStyle = '#e0e6f0'; ctx.save(); ctx.beginPath(); ctx.rect(x + 4, y + 4, Math.max(0, w - 8), 15); ctx.clip(); ctx.fillText(clip.label ?? asset?.name ?? 'Clip', x + 6, y + 12); ctx.restore();
      if (clip.effects.some((e) => e.enabled)) { ctx.fillStyle = '#c7b1eb'; ctx.fillText('fx', x + w - 15, y + 13); }
      if (selected) { ctx.strokeStyle = '#c7bcff'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 4, w - 2, h); ctx.lineWidth = 1; } ctx.globalAlpha = 1;
    }
  }
  ctx.strokeStyle = '#f0a35e'; ctx.beginPath(); ctx.moveTo(playhead * pps + .5, RULER_H); ctx.lineTo(playhead * pps + .5, height); ctx.stroke(); ctx.fillStyle = '#f0a35e'; ctx.beginPath(); ctx.moveTo(playhead * pps - 5, 20); ctx.lineTo(playhead * pps + 5, 20); ctx.lineTo(playhead * pps, 28); ctx.fill();
}
function snapped(time, ignore) {
  let result = q(Math.max(0, time)); if (!snap) return result;
  const targets = [0, playhead, ...project.timeline.tracks.flatMap((track) => track.clips.filter((clip) => clip.id !== ignore).flatMap((clip) => [clip.start, clip.start + clip.duration]))];
  const near = targets.sort((a, b) => Math.abs(a - result) - Math.abs(b - result))[0]; if (Math.abs(near - result) * pps < 8) result = q(near); return result;
}
let gesture = null;
canvas.addEventListener('pointerdown', (event) => {
  if (!project) return; sourceFocused = false;
  const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left + $('timeline-scroll').scrollLeft, y = event.clientY - rect.top + $('timeline-scroll').scrollTop, time = x / pps;
  if (y < RULER_H) { const marker = (project.timeline.markers ?? []).find((m) => Math.abs(m.time * pps - x) < 8); setHead(marker?.time ?? time); return; }
  const track = tracks()[Math.floor((y - RULER_H) / TRACK_H)]; if (!track) return;
  targetTrackId = track.id; const clip = track.clips.find((c) => time >= c.start && time < c.start + c.duration); select(clip?.id ?? null); renderTrackHeaders();
  if (!clip) { setHead(time); return; }
  if (tool === 'razor') { void command('clip_split', { clipId: clip.id, at: q(time) }); return; }
  setHead(time); canvas.setPointerCapture(event.pointerId);
  const edge = tool === 'select' && Math.abs(x - clip.start * pps) < 6 ? 'in' : tool === 'select' && Math.abs(x - (clip.start + clip.duration) * pps) < 6 ? 'out' : null;
  gesture = { pointer: event.pointerId, x, track, clip, edge, tool }; $('tool-status').textContent = edge ? 'Trim ' + edge : tool;
});
canvas.addEventListener('pointermove', (event) => { if (gesture) { const delta = (event.clientX - canvas.getBoundingClientRect().left + $('timeline-scroll').scrollLeft - gesture.x) / pps; $('tool-status').textContent = gesture.tool + ' ' + (delta >= 0 ? '+' : '') + q(delta).toFixed(2) + 's'; } });
canvas.addEventListener('pointerup', async (event) => {
  if (!gesture) return; const g = gesture; gesture = null; const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left + $('timeline-scroll').scrollLeft, delta = q((x - g.x) / pps); if (Math.abs(delta) < 1 / fps()) { $('tool-status').textContent = tool; return; }
  if (g.tool === 'slip') await command('clip_slip', { clipId: g.clip.id, delta });
  else if (g.tool === 'roll') { const right = g.track.clips.find((c) => Math.abs(c.start - (g.clip.start + g.clip.duration)) < 1e-6); if (right) await command('clip_roll', { leftClipId: g.clip.id, rightClipId: right.id, at: snapped(right.start + delta) }); else toast('Roll requires an adjacent clip to the right', 'error'); }
  else if (g.edge) await command('clip_trim', { clipId: g.clip.id, edge: g.edge, time: snapped((g.edge === 'in' ? g.clip.start : g.clip.start + g.clip.duration) + delta, g.clip.id) });
  else { const target = tracks()[Math.floor((event.clientY - rect.top + $('timeline-scroll').scrollTop - RULER_H) / TRACK_H)]; await command('clip_move', { clipId: g.clip.id, start: snapped(g.clip.start + delta, g.clip.id), trackId: target?.id ?? g.track.id }); }
  $('tool-status').textContent = tool; renderTimeline();
});
canvas.addEventListener('pointercancel', () => { gesture = null; });
canvas.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
canvas.addEventListener('drop', async (event) => {
  event.preventDefault(); const id = event.dataTransfer.getData('application/x-freemier-asset') || event.dataTransfer.getData('text/plain'); if (!project.media.some((a) => a.id === id)) return;
  const rect = canvas.getBoundingClientRect(), track = tracks()[Math.floor((event.clientY - rect.top + $('timeline-scroll').scrollTop - RULER_H) / TRACK_H)]; if (!track) return;
  const source = id === sourceAssetId, result = await command('clip_add', { trackId: track.id, assetId: id, start: snapped((event.clientX - rect.left + $('timeline-scroll').scrollLeft) / pps), sourceIn: source ? sourceIn : 0, duration: source ? sourceOut - sourceIn : undefined, strict: true });
  if (result) select(result.clip.id);
});

function setTool(next) { tool = next; for (const button of document.querySelectorAll('[data-tool]')) button.classList.toggle('active', button.dataset.tool === next); $('tool-status').textContent = next[0].toUpperCase() + next.slice(1); canvas.style.cursor = next === 'razor' ? 'crosshair' : next === 'slip' || next === 'roll' ? 'ew-resize' : 'default'; }
function updateTransport() { $('scrub').value = duration() ? String(playhead / duration() * 1000) : '0'; $('timecode').textContent = tc(playhead) + ' / ' + tc(duration()); if (document.activeElement !== $('timecode-input')) $('timecode-input').value = tc(playhead); $('duration-label').textContent = tc(duration()); $('btn-play').textContent = playing ? '❚❚' : '▶'; }
async function togglePlay() { if (!duration()) return; sourceFocused = false; if (!playing && playhead >= duration()) playhead = 0; playing = !playing; if (playing) await audioContext?.resume(); updateTransport(); syncPreview(); }
async function saveProject() { const path = await api.pickProjectSavePath(); if (!path) return; if (await command('project_save', { path })) toast('Project saved'); }
async function openProject() { const path = await api.pickProjectOpenPath(); if (!path) return; playing = sourcePlaying = false; if (await command('project_load', { path })) toast('Project opened'); }
function duplicateSelected() { if (find()) void command('clip_duplicate', { clipId: selectedClipId, start: Math.max(duration(), find().clip.start + find().clip.duration) }); }
function deleteSelected() { if (find()) void command('clip_remove', { clipId: selectedClipId, ripple: $('ripple-delete').checked }); }
function showProgress(value) { if ($('btn-export').disabled) { $('btn-export').textContent = 'Export ' + Math.round(value * 100) + '%'; $('btn-export').dataset.progress = String(value); } }
$('btn-export').addEventListener('click', async () => {
  const path = await api.pickExportPath(); if (!path) return; $('btn-export').disabled = true; showProgress(0); toast('Exporting sequence…');
  try { const result = await api.runExport(path); if (!result.ok) throw new Error(result.error?.message); toast('Exported sequence'); } catch (error) { toast('Export failed: ' + error.message, 'error'); } finally { $('btn-export').disabled = false; $('btn-export').textContent = 'Export ↗'; }
});
api?.onExportProgress?.((event) => showProgress(event.fraction));
$('btn-import').addEventListener('click', async () => { const paths = await api.pickMedia(); for (const path of paths ?? []) { const result = await command('media_import', { path }); if (result) toast('Imported ' + result.asset.name); } });
$('btn-save').addEventListener('click', saveProject); $('btn-open').addEventListener('click', openProject);
$('btn-undo').addEventListener('click', () => command('undo')); $('btn-redo').addEventListener('click', () => command('redo'));
$('btn-play').addEventListener('click', togglePlay); $('btn-start').addEventListener('click', () => setHead(0)); $('btn-end').addEventListener('click', () => setHead(duration())); $('btn-prev').addEventListener('click', () => setHead(playhead - 1 / fps())); $('btn-next').addEventListener('click', () => setHead(playhead + 1 / fps()));
$('scrub').addEventListener('input', () => { sourceFocused = false; setHead(Number($('scrub').value) / 1000 * duration()); });
$('timecode-input').addEventListener('change', () => { try { setHead(parseFrameTimecode($('timecode-input').value, fps())); } catch (error) { toast(error.message, 'error'); updateTransport(); } });
$('source-monitor').addEventListener('pointerdown', () => sourceFocused = true); $('program-monitor').addEventListener('pointerdown', () => sourceFocused = false);
$('source-scrub').addEventListener('input', () => { const asset = project?.media.find((a) => a.id === sourceAssetId); if (asset) sourceSeek(Number($('source-scrub').value) / 1000 * asset.duration); });
$('source-prev').addEventListener('click', () => sourceSeek(sourceHead - 1 / fps())); $('source-next').addEventListener('click', () => sourceSeek(sourceHead + 1 / fps()));
$('source-play').addEventListener('click', () => { if (sourceEl) { sourcePlaying = !sourcePlaying; updateSource(); } });
$('source-in').addEventListener('click', () => { if (sourceAssetId && sourceHead < sourceOut) { sourceIn = q(sourceHead); updateSource(); } });
$('source-out').addEventListener('click', () => { if (sourceAssetId && sourceHead > sourceIn) { sourceOut = q(sourceHead); updateSource(); } });
$('source-clear').addEventListener('click', () => { const asset = project?.media.find((a) => a.id === sourceAssetId); if (asset) { sourceIn = 0; sourceOut = asset.duration; updateSource(); } });
$('source-place').addEventListener('click', placeSource); $('source-track').addEventListener('change', () => { targetTrackId = $('source-track').value; renderTrackHeaders(); });
$('bin-search').addEventListener('input', renderMediaBin); $('bin-view').addEventListener('click', () => { grid = !grid; $('bin-view').textContent = grid ? '▦' : '☷'; renderMediaBin(); });
for (const button of document.querySelectorAll('[data-browser]')) button.addEventListener('click', () => { browser = button.dataset.browser; $('bin-search').value = ''; document.querySelectorAll('[data-browser]').forEach((b) => b.classList.toggle('active', b === button)); renderMediaBin(); });
for (const button of document.querySelectorAll('#workspace-tabs [data-workspace]')) button.addEventListener('click', () => { workspace = button.dataset.workspace; document.body.dataset.workspace = workspace; document.querySelectorAll('#workspace-tabs button').forEach((b) => b.classList.toggle('active', b === button)); renderInspector(); });
for (const button of document.querySelectorAll('[data-tool]')) button.addEventListener('click', () => setTool(button.dataset.tool));
$('btn-snap').addEventListener('click', () => { snap = !snap; $('btn-snap').classList.toggle('active', snap); }); $('btn-duplicate').addEventListener('click', duplicateSelected); $('btn-delete').addEventListener('click', deleteSelected);
$('timeline-zoom').addEventListener('input', () => { pps = Number($('timeline-zoom').value); renderTimeline(); }); $('zoom-fit').addEventListener('click', () => { pps = Math.max(20, Math.min(300, $('timeline-scroll').clientWidth / Math.max(duration() + .5, 1))); $('timeline-zoom').value = pps; renderTimeline(); });
$('timeline-scroll').addEventListener('scroll', () => { $('track-headers').scrollTop = $('timeline-scroll').scrollTop; renderTimeline(); });
new ResizeObserver(renderTimeline).observe($('timeline-scroll'));
$('btn-add-video').addEventListener('click', () => command('track_add', { kind: 'video' })); $('btn-add-audio').addEventListener('click', () => command('track_add', { kind: 'audio' }));
$('btn-marker').addEventListener('click', addAtHead); $('marker-create').addEventListener('click', addAtHead);
$('marker-prev').addEventListener('click', () => navigateMarker(-1)); $('marker-next').addEventListener('click', () => navigateMarker(1));
document.addEventListener('keydown', (event) => {
  if (event.target.closest?.('input,textarea,select,[contenteditable=true]')) return;
  const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
  if (mod && key === 's') { event.preventDefault(); void saveProject(); }
  else if (mod && key === 'o') { event.preventDefault(); void openProject(); }
  else if (mod && key === 'z') { event.preventDefault(); void command(event.shiftKey ? 'redo' : 'undo'); }
  else if (mod && key === 'd') { event.preventDefault(); duplicateSelected(); }
  else if (key === ' ') { event.preventDefault(); if (sourceFocused && sourceEl) { sourcePlaying = !sourcePlaying; updateSource(); } else void togglePlay(); }
  else if (key === 'arrowleft' || key === 'arrowright') { event.preventDefault(); const delta = (key === 'arrowright' ? 1 : -1) / fps(); if (sourceFocused) sourceSeek(sourceHead + delta); else setHead(playhead + delta); }
  else if (key === 'home') setHead(0); else if (key === 'end') setHead(duration());
  else if (key === 'delete' || key === 'backspace') { event.preventDefault(); deleteSelected(); }
  else if (key === 's') $('btn-snap').click();
  else if (key === 'm') { event.preventDefault(); void addAtHead(); }
  else if (['v', 'c', 'y', 'n'].includes(key)) setTool({ v: 'select', c: 'razor', y: 'slip', n: 'roll' }[key]);
  else if (sourceFocused && key === 'i') $('source-in').click(); else if (sourceFocused && key === 'o') $('source-out').click();
});
let lastTick = performance.now();
function tick(now) {
  const delta = Math.min(.1, (now - lastTick) / 1000); lastTick = now;
  if (playing) { playhead = Math.min(duration(), playhead + delta); if (playhead >= duration()) playing = false; updateTransport(); syncPreview(); renderTimeline(); }
  if (sourcePlaying) { const asset = project?.media.find((a) => a.id === sourceAssetId); sourceHead = Math.min(asset?.duration ?? 0, sourceHead + delta); if (sourceHead >= (asset?.duration ?? 0)) sourcePlaying = false; updateSource(); }
  const sel = find(), analyser = sel && decoders.get(sel.clip.id)?.analyser;
  if ($('audio-meter-fill')) { let rms = 0; if (analyser) { const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples); rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length); }
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity; $('audio-meter-fill').style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%'; $('audio-meter-label').textContent = 'RMS ' + (Number.isFinite(db) ? db.toFixed(1) : '−∞') + ' dBFS · decoded output';
  }
  requestAnimationFrame(tick);
}
window.addEventListener('resize', () => { renderTimeline(); drawProgram(); }); api?.onCheckState?.(report);
async function boot() { try { await api.getInfo(); } catch {} connect(); try { const state = await (await fetch(BRIDGE + '/state')).json(); if (!project) applyState(state.project, state.revision, state); } catch {} }
requestAnimationFrame(tick); void boot();
