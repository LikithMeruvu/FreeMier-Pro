
export function bindSourceMonitorEvents(ui) {
  ui.$('source-monitor').addEventListener('pointerdown', () => ui.sourceFocused = true);
  ui.$('source-scrub').addEventListener('input', () => {
    const asset = ui.project?.media.find((a) => a.id === ui.sourceAssetId); if (asset)
      ui.sourceSeek(Number(ui.$('source-scrub').value) / 1000 * asset.duration);
  });
  ui.$('source-prev').addEventListener('click', () => ui.sourceSeek(ui.sourceHead - 1 / ui.fps()));
  ui.$('source-next').addEventListener('click', () => ui.sourceSeek(ui.sourceHead + 1 / ui.fps()));
  ui.$('source-play').addEventListener('click', () => {
    if (ui.sourceEl) {
      ui.sourcePlaying = !ui.sourcePlaying;
      ui.updateSource();
    }
  });
  ui.$('source-in').addEventListener('click', () => {
    if (ui.sourceAssetId && ui.sourceHead < ui.sourceOut) {
      ui.sourceIn = ui.q(ui.sourceHead);
      ui.updateSource();
    }
  });
  ui.$('source-out').addEventListener('click', () => {
    if (ui.sourceAssetId && ui.sourceHead > ui.sourceIn) {
      ui.sourceOut = ui.q(ui.sourceHead);
      ui.updateSource();
    }
  });
  ui.$('source-clear').addEventListener('click', () => {
    const asset = ui.project?.media.find((a) => a.id === ui.sourceAssetId); if (asset) {
      ui.sourceIn = 0;
      ui.sourceOut = asset.duration;
      ui.updateSource();
    }
  });
  ui.$('source-place').addEventListener('click', ui.placeSource);
  ui.$('source-track').addEventListener('change', () => { ui.targetTrackId = ui.$('source-track').value; ui.renderTrackHeaders(); });
  document.addEventListener('keydown', (event) => {
    if (event.target.closest?.('input,textarea,select,[contenteditable=true]'))
      return;
    const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
    if (mod && key === 's') {
      event.preventDefault();
      void ui.saveProject();
    }
    else if (mod && key === 'o') {
      event.preventDefault();
      void ui.openProject();
    }
    else if (mod && key === 'z') {
      event.preventDefault();
      void ui.command(event.shiftKey ? 'redo' : 'undo');
    }
    else if (mod && key === 'd') {
      event.preventDefault();
      ui.duplicateSelected();
    }
    else if (key === ' ') {
      event.preventDefault();
      if (ui.sourceFocused && ui.sourceEl) {
        ui.sourcePlaying = !ui.sourcePlaying;
        ui.updateSource();
      }
      else
        void ui.togglePlay();
    }
    else if (key === 'arrowleft' || key === 'arrowright') {
      event.preventDefault();
      const delta = (key === 'arrowright' ? 1 : -1) / ui.fps();
      if (ui.sourceFocused)
        ui.sourceSeek(ui.sourceHead + delta);
      else
        ui.setHead(ui.playhead + delta);
    }
    else if (key === 'home')
      ui.setHead(0);
    else if (key === 'end')
      ui.setHead(ui.duration());
    else if (key === 'delete' || key === 'backspace') {
      event.preventDefault();
      ui.deleteSelected();
    }
    else if (key === 's')
      ui.$('btn-snap').click();
    else if (key === 'm') {
      event.preventDefault();
      void ui.addAtHead();
    }
    else if (['v', 'c', 'y', 'n'].includes(key))
      ui.setTool({ v: 'select', c: 'razor', y: 'slip', n: 'roll' }[key]);
    else if (ui.sourceFocused && key === 'i')
      ui.$('source-in').click();
    else if (ui.sourceFocused && key === 'o')
      ui.$('source-out').click();
  });
}
