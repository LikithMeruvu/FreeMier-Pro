import { captionDuration } from '@freemier/shared/captions';

/** Presentation state only. The service owns the editable project. */
export function createViewState() {
  const ui = {};
  ui.BRIDGE = 'http://127.0.0.1:' + (new URLSearchParams(location.search).get('bridge') ?? '4317');
  ui.api = window.freemier ?? window.palmier;
  ui.$ = (id) => document.getElementById(id);
  ui.project = null;
  ui.revision = -1;
  ui.playhead = 0;
  ui.playing = false;
  ui.selectedClipId = null;
  ui.workspace = 'edit';
  ui.browser = 'project';
  ui.tool = 'select';
  ui.snap = true;
  ui.pps = 90;
  ui.grid = true;
  ui.workspaceSettings = null;
  ui.projectProtection = null;
  ui.eventEpoch = null;
  ui.eventSequence = -1;
  ui.sourceAssetId = null;
  ui.sourceHead = 0;
  ui.sourceIn = 0;
  ui.sourceOut = 0;
  ui.sourcePlaying = false;
  ui.sourceEl = null;
  ui.targetTrackId = null;
  ui.sourceFocused = false;
  ui.audioContext = null;
  ui.applying = false;
  ui.decoders = new Map();
  ui.thumbs = new Map();
  ui.pendingThumbs = new Map();
  ui.waveforms = new Map();
  ui.pixelProcessors = new Map();
  ui.scratch = document.createElement('canvas');
  ui.scratch2 = document.createElement('canvas');
  ui.program = ui.$('program-canvas');
  ui.programCtx = ui.program.getContext('2d', { willReadFrequently: true });
  ui.canvas = ui.$('timeline');
  ui.ctx = ui.canvas.getContext('2d');
  ui.TRACK_H = 62;
  ui.RULER_H = 28;
  ui.fps = () => ui.project?.timeline.fps ?? 30;
  ui.q = (t) => Math.round(t * ui.fps()) / ui.fps();
  ui.tracks = () => (ui.project?.timeline.tracks ?? []).map((track, index) => ({ track, index }))
    .sort((a, b) => b.track.order - a.track.order || b.index - a.index).map(({ track }) => track);
  ui.duration = () => Math.max(0, ...(ui.project?.timeline.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)) ?? []), ...(ui.project?.timeline.titles ?? []).map((t) => t.end), captionDuration(ui.project?.timeline.captions?.cues ?? [], ui.fps()));
  ui.viewEnd = () => Math.max(ui.duration(), ...(ui.project?.timeline.markers ?? []).map((m) => m.time));
  ui.find = (id = ui.selectedClipId) => {
    for (const track of ui.project?.timeline.tracks ?? []) {
      const clip = track.clips.find((c) => c.id === id);
      if (clip)
        return { track, clip };
    } return null;
  };
  ui.assetFor = (clip) => ui.project?.media.find((m) => m.id === clip.assetId);
  ui.mediaUrl = (asset) => ui.BRIDGE + '/media/' + encodeURIComponent(asset.id);
  ui.titleRasters = new Map();
  ui.local = (clip) => Math.max(0, Math.min(clip.duration, ui.playhead - clip.start));
  ui.gesture = null;
  ui.lastTick = performance.now();
  return ui;
}
