
export function registerPanelsExportExport(ui) {
  function showProgress(value) {
    if (ui.$('btn-export').disabled) {
      ui.$('btn-export').textContent = 'Export ' + Math.round(value * 100) + '%';
      ui.$('btn-export').dataset.progress = String(value);
    }
  }
  Object.assign(ui, { showProgress });
}
