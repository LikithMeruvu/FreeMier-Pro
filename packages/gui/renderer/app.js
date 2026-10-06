/**
 * Renderer.
 *
 * The single most important behaviour here: subscribing to the bridge's SSE
 * stream and re-rendering on every change. That is what makes an agent's edit
 * appear on screen without a reload.
 */

const params = new URLSearchParams(location.search);
const BRIDGE = `http://127.0.0.1:${params.get('bridge') ?? '4317'}`;

const els = {
  projectName: document.getElementById('project-name'),
  liveStatus: document.getElementById('live-status'),
  liveText: document.getElementById('live-text'),
  mediaBin: document.getElementById('media-bin'),
  timeline: document.getElementById('timeline'),
  revision: document.getElementById('revision'),
  inspector: document.getElementById('inspector'),
  stage: document.getElementById('preview-stage'),
  empty: document.getElementById('preview-empty'),
  play: document.getElementById('btn-play'),
  scrub: document.getElementById('scrub'),
  timecode: document.getElementById('timecode'),
  import: document.getElementById('btn-import'),
  exportBtn: document.getElementById('btn-export'),
  toast: document.getElementById('toast'),
};

/** Latest project state pushed from the bridge. */
let project = null;
let revision = -1;
let playhead = 0;
let playing = false;
let selectedClipId = null;

/** Each clip needs its own decoder, including clips sharing one source. */
const videoCache = new Map();
/** Cache of thumbnail blob URLs keyed by asset id. */
const thumbCache = new Map();
const pendingThumbs = new Map();
const waveformCache = new Map();

// ---------------------------------------------------------------- utilities

function toast(message, kind = '') {
  els.toast.textContent = message;
  els.toast.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.className = 'toast'; }, 3200);
}

function fmt(seconds) {
  const s = Math.max(0, seconds);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  const cs = String(Math.floor((s % 1) * 100)).padStart(2, '0');
  return `${mm}:${ss}.${cs}`;
}

function timelineDuration() {
  if (!project) return 0;
  let max = 0;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) max = Math.max(max, clip.start + clip.duration);
  }
  return max;
}

function assetFor(clip) {
  return project?.media.find((m) => m.id === clip.assetId) ?? null;
}

function selectedClip() {
  if (!project || !selectedClipId) return null;
  for (const track of project.timeline.tracks) {
    const clip = track.clips.find((c) => c.id === selectedClipId);
    if (clip) return { clip, track };
  }
  return null;
}

/** Resolve a media asset's absolute path (copied assets live under workspace/media). */
function assetUrl(asset) {
  if (!asset) return null;
  const p = asset.path.replace(/\\/g, '/');
  const absolute = p.startsWith('/') || /^[A-Za-z]:/.test(p) ? p : `${workspaceDir}/${asset.copied ? 'media/' : ''}${p}`;
  const normalized = absolute.replace(/\\/g, '/');
  const encoded = encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return `file://${normalized.startsWith('/') ? '' : '/'}${encoded}`;
}

let workspaceDir = '';
let mode = 'standalone';

// ------------------------------------------------------------- live syncing

function setLive(state, text) {
  els.liveStatus.className = `live-status ${state}`;
  els.liveText.textContent = text;
}

function connect() {
  const source = new EventSource(`${BRIDGE}/events`);

  source.addEventListener('open', () => setLive('on', 'live'));

  source.onmessage = (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.type === 'snapshot' || payload.type === 'change') {
      applyState(payload.state.project ?? payload.state, payload.revision ?? payload.state.revision);
      if (payload.type === 'change') setLive('on', `live · ${payload.kind}`);
    } else if (payload.type === 'export-progress') {
      showExportProgress(payload.fraction);
    }
  };

  source.onerror = () => {
    setLive('off', 'reconnecting…');
    // EventSource retries automatically; nothing to do here.
  };
}

function applyState(next, nextRevision = next?.revision) {
  if (!next || !next.timeline) return;
  project = next;
  revision = nextRevision ?? revision;
  playhead = Math.min(playhead, timelineDuration());
  els.projectName.textContent = next.name ?? 'Untitled Project';
  els.revision.textContent = `rev ${revision}`;
  renderMediaBin();
  renderTimeline();
  renderInspector();
  syncPreview();
  updateTransport();
  reportRenderedState();
}

/**
 * Report what was actually rendered. This is how an automated check confirms
 * that an agent's edit reached the screen, not merely the store.
 */
function reportRenderedState() {
  try {
    window.palmier?.reportState?.({
      revision,
      projectName: project?.name ?? null,
      mediaCount: project?.media?.length ?? 0,
      clipCount: (project?.timeline?.tracks ?? []).reduce((n, t) => n + t.clips.length, 0),
      trackCount: project?.timeline?.tracks?.length ?? 0,
      duration: timelineDuration(),
      mediaItemsRendered: els.mediaBin.querySelectorAll('.media-item').length,
      previewVideos: els.stage.querySelectorAll('video').length,
      lastRenderedAt: Date.now(),
    });
  } catch { /* reporting must never break rendering */ }
}

// -------------------------------------------------------------- media bin

function renderMediaBin() {
  if (!project) return;
  const media = project.media ?? [];
  if (media.length === 0) {
    els.mediaBin.innerHTML = '<div class="empty">No media yet — import a file or let the agent add one.</div>';
    return;
  }

  els.mediaBin.replaceChildren(...media.map((asset) => {
    const row = document.createElement('div');
    row.className = 'media-item';

    const img = document.createElement('img');
    img.className = 'media-thumb';
    if (thumbCache.has(asset.id)) {
      img.src = thumbCache.get(asset.id);
    } else {
      loadThumbnail(asset, img);
    }

    const meta = document.createElement('div');
    meta.className = 'media-meta';
    const name = document.createElement('div');
    name.className = 'media-name';
    name.textContent = asset.name;
    name.title = asset.path;
    const sub = document.createElement('div');
    sub.className = 'media-sub';
    sub.textContent = `${asset.kind} · ${fmt(asset.duration)}${asset.width ? ` · ${asset.width}×${asset.height}` : ''}`;
    meta.append(name, sub);

    row.append(img, meta);
    return row;
  }));
}

/** Ask the main process for a poster frame; fall back to a blank tile. */
async function loadThumbnail(asset, img) {
  try {
    const url = assetUrl(asset);
    if (!url) return;
    if (asset.kind === 'image') { img.src = url; thumbCache.set(asset.id, url); return; }
    if (asset.kind === 'audio') return;
    if (!pendingThumbs.has(asset.id)) pendingThumbs.set(asset.id, fetch(`${BRIDGE}/thumbnail`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: asset.id }),
    }).then((r) => r.json()));
    const poster = await pendingThumbs.get(asset.id);
    if (poster.ok) { thumbCache.set(asset.id, poster.dataUrl); img.src = poster.dataUrl; }
  } catch { /* leave the blank tile */ }
}

// --------------------------------------------------------------- timeline

const canvas = els.timeline;
const ctx = canvas.getContext('2d');

const TRACK_H = 46;
const RULER_H = 22;
const HEADER_W = 54;

function renderTimeline() {
  if (!project) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#16181f';
  ctx.fillRect(0, 0, W, H);

  const tracks = project.timeline.tracks;
  canvas.dataset.waveformPeaks = String([...waveformCache.values()].reduce((n, peaks) => n + peaks.length, 0));
  const duration = Math.max(timelineDuration(), 1);
  const laneW = W - HEADER_W;

  const xOf = (t) => HEADER_W + (t / duration) * laneW;
  const tOf = (x) => ((x - HEADER_W) / laneW) * duration;
  canvas._xOf = xOf; canvas._tOf = tOf;

  // Ruler
  ctx.fillStyle = '#1c1f28';
  ctx.fillRect(0, 0, W, RULER_H);
  ctx.strokeStyle = '#262a35';
  ctx.beginPath(); ctx.moveTo(0, RULER_H + .5); ctx.lineTo(W, RULER_H + .5); ctx.stroke();

  const step = niceStep(duration);
  ctx.fillStyle = '#8a90a2';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  for (let t = 0; t <= duration; t += step) {
    const x = xOf(t);
    ctx.strokeStyle = '#2a2f3b';
    ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillText(fmt(t).slice(0, 5), x + 3, RULER_H / 2);
  }

  // Tracks (draw bottom-up so higher order appears on top)
  [...tracks].sort((a, b) => b.order - a.order).forEach((track, i) => {
    const y = RULER_H + i * TRACK_H;
    ctx.fillStyle = track.kind === 'video' ? '#191d27' : '#181f1d';
    ctx.fillRect(HEADER_W, y, laneW, TRACK_H - 2);

    ctx.fillStyle = '#8a90a2';
    ctx.font = '11px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(track.name, 10, y + TRACK_H / 2);

    for (const clip of track.clips) {
      const cx = xOf(clip.start);
      const cw = Math.max(2, xOf(clip.start + clip.duration) - cx);
      const cy = y + 4;
      const ch = TRACK_H - 10;
      const isSel = clip.id === selectedClipId;

      ctx.fillStyle = isSel ? '#6ea8fe' : (track.kind === 'video' ? '#3b6ea5' : '#3f7a68');
      roundRect(ctx, cx, cy, cw, ch, 4);
      ctx.fill();

      if (track.kind === 'audio') {
        const asset = assetFor(clip);
        if (asset?.hasAudio && !waveformCache.has(asset.id)) {
          waveformCache.set(asset.id, []);
          fetch(`${BRIDGE}/waveform`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: asset.id }) })
            .then((r) => r.json()).then((body) => { if (body.ok) waveformCache.set(asset.id, body.peaks); renderTimeline(); }).catch(() => {});
        }
        const peaks = waveformCache.get(asset?.id) ?? [];
        ctx.strokeStyle = 'rgba(255,255,255,.28)';
        ctx.beginPath();
        for (let px = cx + 2; px < cx + cw - 2; px += 3) {
          const sourceTime = clip.sourceIn + ((px - cx) / cw) * clip.duration;
          const peak = peaks[Math.min(peaks.length - 1, Math.floor((sourceTime / (asset?.duration || 1)) * peaks.length))] ?? 0;
          const h = peak * Math.min(1, clip.volume) * (ch - 10);
          ctx.moveTo(px, cy + ch / 2 - h / 2);
          ctx.lineTo(px, cy + ch / 2 + h / 2);
        }
        ctx.stroke();
      }

      if (cw > 46) {
        ctx.fillStyle = isSel ? '#0b1420' : '#dfe6f5';
        ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
        const label = clip.label ?? assetFor(clip)?.name ?? 'clip';
        ctx.save();
        ctx.beginPath(); ctx.rect(cx + 4, cy, cw - 8, ch); ctx.clip();
        ctx.fillText(label, cx + 6, cy + ch / 2);
        ctx.restore();
      }
    }
  });

  // Playhead
  const px = xOf(playhead);
  ctx.strokeStyle = '#f0a35e';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(px, RULER_H); ctx.lineTo(px, H); ctx.stroke();
  ctx.fillStyle = '#f0a35e';
  ctx.beginPath();
  ctx.moveTo(px - 5, RULER_H); ctx.lineTo(px + 5, RULER_H); ctx.lineTo(px, RULER_H + 8);
  ctx.closePath(); ctx.fill();
  ctx.lineWidth = 1;
}

function niceStep(duration) {
  const raw = duration / 8;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 0.001))));
  for (const m of [1, 2, 5, 10]) {
    if (pow * m >= raw) return pow * m;
  }
  return pow * 10;
}

function roundRect(c, x, y, w, h, r) {
  const radius = Math.min(r, h / 2, w / 2);
  c.beginPath();
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}

// ---------------------------------------------------------------- preview

function syncPreview() {
  if (!project) return;
  const active = clipsAt(playhead);
  const wanted = new Set(active.map((c) => c.id));

  // Remove elements for clips no longer under the playhead.
  for (const [clipId, el] of videoCache) {
    if (!wanted.has(clipId)) { if (el.pause) el.pause(); el.remove(); videoCache.delete(clipId); }
  }

  if (active.length === 0) {
    els.empty.style.display = '';
    return;
  }
  els.empty.style.display = 'none';

  for (const clip of active) {
    let el = videoCache.get(clip.id);
    const asset = assetFor(clip);
    if (!asset) continue;
    const track = project.timeline.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
    if (!el) {
      el = document.createElement(asset.kind === 'image' ? 'img' : track.kind === 'audio' || asset.kind === 'audio' ? 'audio' : 'video');
      el.src = assetUrl(asset);
      el.dataset.clipId = clip.id;
      // Audio is mixed from audio tracks, matching the export pipeline.
      el.muted = track.kind === 'video';
      el.preload = 'auto';
      el.addEventListener('loadeddata', () => { syncPreview(); reportRenderedState(); });
      els.stage.appendChild(el);
      videoCache.set(clip.id, el);
    }

    // Map timeline time to source time, honouring the clip's in-point.
    const sourceTime = clip.sourceIn + (playhead - clip.start);
    if (asset.kind !== 'image' && Math.abs((el.currentTime ?? 0) - sourceTime) > 0.12) {
      try { el.currentTime = Math.max(0, sourceTime); } catch { /* not seekable yet */ }
    }

    const t = clip.transform;
    const outputWidth = Math.min(els.stage.clientWidth, els.stage.clientHeight * project.timeline.width / project.timeline.height);
    const outputHeight = outputWidth * project.timeline.height / project.timeline.width;
    if (el.tagName !== 'AUDIO') { el.style.width = `${outputWidth}px`; el.style.height = `${outputHeight}px`; el.style.objectFit = 'contain'; }
    const scale = t.scale.value;
    const dx = (t.x.value * outputWidth);
    const dy = (t.y.value * outputHeight);
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${scale}) rotate(${t.rotation.value}deg)`;
    el.style.opacity = String(t.opacity.value);
    el.volume = Math.min(1, Math.max(0, clip.volume));
    el.style.zIndex = String(track.order);

    if (el.play) { if (playing) { el.play().catch(() => {}); } else { el.pause(); } }
  }
}

/** Clips covering a timeline instant, across all unmuted, visible tracks. */
function clipsAt(time) {
  const out = [];
  if (!project) return out;
  for (const track of project.timeline.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (time >= clip.start - 1e-6 && time < clip.start + clip.duration - 1e-6) out.push(clip);
    }
  }
  return out;
}

// -------------------------------------------------------------- inspector

function renderInspector() {
  const sel = selectedClip();
  if (!sel) {
    els.inspector.innerHTML = '<div class="empty">Select a clip to edit it.</div>';
    return;
  }
  const { clip, track } = sel;
  const asset = assetFor(clip);

  els.inspector.replaceChildren();

  const addReadonly = (label, value) => {
    const f = document.createElement('div');
    f.className = 'field';
    const l = document.createElement('label'); l.textContent = label;
    const v = document.createElement('div'); v.textContent = value;
    f.append(l, v);
    els.inspector.appendChild(f);
  };

  addReadonly('Track', track.name);
  addReadonly('Source', asset?.name ?? '(missing)');
  addReadonly('Position', `${fmt(clip.start)} → ${fmt(clip.start + clip.duration)}`);
  addReadonly('Source in/out', `${fmt(clip.sourceIn)} → ${fmt(clip.sourceOut)}`);

  const slider = (label, value, min, max, step, onChange) => {
    const f = document.createElement('div');
    f.className = 'field';
    const l = document.createElement('label');
    l.textContent = label;
    const val = document.createElement('span');
    val.className = 'value';
    val.textContent = value.toFixed(2);
    l.appendChild(val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(value);
    input.setAttribute('aria-label', label);
    input.addEventListener('input', () => {
      val.textContent = Number(input.value).toFixed(2);
      onChange(Number(input.value));
    });
    f.append(l, input);
    els.inspector.appendChild(f);
  };

  const t = clip.transform;
  slider('Scale', t.scale.value, 0.1, 3, 0.01, (v) => command('clip_transform', { clipId: clip.id, scale: v }));
  slider('Position X', t.x.value, -1, 1, 0.01, (v) => command('clip_transform', { clipId: clip.id, x: v }));
  slider('Position Y', t.y.value, -1, 1, 0.01, (v) => command('clip_transform', { clipId: clip.id, y: v }));
  slider('Opacity', t.opacity.value, 0, 1, 0.01, (v) => command('clip_transform', { clipId: clip.id, opacity: v }));
  slider('Rotation', t.rotation.value, -180, 180, 1, (v) => command('clip_transform', { clipId: clip.id, rotation: v }));
  slider('Volume', clip.volume, 0, 2, 0.01, (v) => command('clip_audio', { clipId: clip.id, volume: v }));
}

// ---------------------------------------------------------------- commands

async function command(action, payload) {
  if (!project) return null;
  try {
    const res = await fetch(`${BRIDGE}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error?.message ?? 'command failed');
    return body;
  } catch (err) {
    toast(String(err.message ?? err), 'error');
    return null;
  }
}

// -------------------------------------------------------------- interaction

canvas.addEventListener('pointerdown', (event) => {
  if (!project || !canvas._tOf) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  if (y < RULER_H) {
    playhead = Math.max(0, canvas._tOf(x));
    updateTransport();
    syncPreview();
    renderTimeline();
    return;
  }

  // Hit-test clips.
  const tracks = [...project.timeline.tracks].sort((a, b) => b.order - a.order);
  const index = Math.floor((y - RULER_H) / TRACK_H);
  const track = tracks[index];
  if (!track) return;
  const t = canvas._tOf(x);
  const clip = track.clips.find((c) => t >= c.start && t < c.start + c.duration);

  selectedClipId = clip?.id ?? null;
  if (clip) playhead = t;

  renderTimeline();
  renderInspector();
  updateTransport();
  syncPreview();
});

function updateTransport() {
  const duration = timelineDuration();
  els.scrub.value = String(duration > 0 ? Math.round((playhead / duration) * 1000) : 0);
  els.timecode.textContent = `${fmt(playhead)} / ${fmt(duration)}`;
}

els.scrub.addEventListener('input', () => {
  const duration = timelineDuration();
  playhead = (Number(els.scrub.value) / 1000) * duration;
  updateTransport();
  syncPreview();
  renderTimeline();
});

els.play.addEventListener('click', () => {
  if (!project || timelineDuration() <= 0) return;
  playing = !playing;
  els.play.textContent = playing ? '❚❚' : '▶';
  syncPreview();
});

els.import.addEventListener('click', async () => {
  if (!project) return;
  try {
  const paths = await window.palmier.pickMedia();
  if (!paths?.length) return;
  for (const p of paths) {
    // Always route through the bridge so viewer mode edits the agent's timeline.
    const res = await command('media_import', { path: p });
    if (res) toast(`Imported ${p.split(/[\\/]/).pop()}`, 'ok');
  }
  } catch (err) { toast(`Import failed: ${err.message ?? err}`, 'error'); }
});

function showExportProgress(fraction) {
  if (els.exportBtn.disabled) {
    els.exportBtn.textContent = `Export ${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    els.exportBtn.dataset.progress = String(fraction);
  }
}
window.palmier?.onExportProgress?.((progress) => showExportProgress(progress.fraction));

els.exportBtn.addEventListener('click', async () => {
  if (!project || els.exportBtn.disabled) return;
  try {
  const target = await window.palmier.pickExportPath();
  if (!target) return;
  els.exportBtn.disabled = true;
  showExportProgress(0);
  toast('Exporting…');
  const result = await window.palmier.runExport(target);
  if (result.ok) toast(`Exported ${result.outputPath}`, 'ok');
  else toast(`Export failed: ${result.error?.message}`, 'error');
  } catch (err) { toast(`Export failed: ${err.message ?? err}`, 'error'); }
  finally { els.exportBtn.disabled = false; els.exportBtn.textContent = 'Export'; }
});

window.addEventListener('resize', () => { renderTimeline(); syncPreview(); });

// Playback loop: advance the playhead in real time.
let lastTick = performance.now();
function tick(now) {
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  if (playing) {
    playhead += dt;
    const duration = timelineDuration();
    if (playhead >= duration) { playhead = duration; playing = false; els.play.textContent = '▶'; }
    updateTransport();
    syncPreview();
    renderTimeline();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ------------------------------------------------------------------- boot

window.palmier?.onCheckState?.(() => reportRenderedState());

async function boot() {
  // Live sync must survive any single IPC failure — connect() always runs.
  try {
    const info = await window.palmier.getInfo();
    workspaceDir = info?.workspace ?? '';
    mode = info?.viewerMode ? 'viewer' : 'standalone';
  } catch { /* defaults keep the editor usable */ }
  workspaceDir = workspaceDir || '';
  connect();
  // Initial paint from /state in case the SSE snapshot raced our subscribe.
  try {
    const res = await fetch(`${BRIDGE}/state`);
    const body = await res.json();
    applyState(body.project ?? body, body.revision);
  } catch { /* the stream will deliver it */ }
}

void boot();
