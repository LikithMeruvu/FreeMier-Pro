import { parseFrameTimecode } from '@freemier/shared/timecode';
import { bindCaptionsEvents } from '../panels/captions/events.js';
import { bindExportEvents } from '../panels/export/events.js';
import { bindMarkersEvents } from '../panels/markers/events.js';
import { bindPresetsEvents } from '../panels/presets/events.js';
import { bindProjectEvents } from '../panels/project/events.js';
import { bindSourceMonitorEvents } from '../panels/source-monitor/events.js';
import { bindTimelineEvents } from '../panels/timeline/events.js';
import { bindTitlesEvents } from '../panels/titles/events.js';

export function bindWorkspaceEvents(ui) {
  bindTimelineEvents(ui);
  bindExportEvents(ui);
  bindProjectEvents(ui);
  bindSourceMonitorEvents(ui);
  bindMarkersEvents(ui);
  bindTitlesEvents(ui);
  bindCaptionsEvents(ui);
  bindPresetsEvents(ui);
  ui.$('btn-save').addEventListener('click', ui.saveProject);
  ui.$('btn-open').addEventListener('click', ui.openProject);
  ui.$('btn-undo').addEventListener('click', () => ui.command('undo'));
  ui.$('btn-redo').addEventListener('click', () => ui.command('redo'));
  ui.$('btn-play').addEventListener('click', ui.togglePlay);
  ui.$('btn-start').addEventListener('click', () => ui.setHead(0));
  ui.$('btn-end').addEventListener('click', () => ui.setHead(ui.duration()));
  ui.$('btn-prev').addEventListener('click', () => ui.setHead(ui.playhead - 1 / ui.fps()));
  ui.$('btn-next').addEventListener('click', () => ui.setHead(ui.playhead + 1 / ui.fps()));
  ui.$('scrub').addEventListener('input', () => { ui.sourceFocused = false; ui.setHead(Number(ui.$('scrub').value) / 1000 * ui.duration()); });
  ui.$('timecode-input').addEventListener('change', () => {
    try {
      ui.setHead(parseFrameTimecode(ui.$('timecode-input').value, ui.fps()));
    }
    catch (error) {
      ui.toast(error.message, 'error');
      ui.updateTransport();
    }
  });
  ui.$('program-monitor').addEventListener('pointerdown', () => ui.sourceFocused = false);
  for (const button of document.querySelectorAll('#workspace-tabs [data-workspace]'))
    button.addEventListener('click', () => ui.setWorkspaceMode(button.dataset.workspace));
  window.addEventListener('resize', () => { ui.renderTimeline(); ui.drawProgram(); });
  ui.api?.onCheckState?.(ui.report);
}
