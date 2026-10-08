
export function bindExportEvents(ui) {
  ui.$('btn-export').addEventListener('click', async () => {
    const path = await ui.api.pickExportPath();
    if (!path)
      return;
    ui.$('btn-export').disabled = true;
    ui.showProgress(0);
    ui.toast('Exporting sequence…');
    try {
      const result = await ui.api.runExport(path, ui.$('caption-policy').value);
      if (!result.ok)
        throw new Error(result.error?.message);
      ui.toast(result.sidecarPath ? 'Exported video and captions: ' + result.sidecarPath : 'Exported sequence');
    }
    catch (error) {
      ui.toast('Export failed: ' + error.message, 'error');
    }
    finally {
      ui.$('btn-export').disabled = false;
      ui.$('btn-export').textContent = 'Export ↗';
    }
  });
  ui.api?.onExportProgress?.((event) => ui.showProgress(event.fraction));
}
