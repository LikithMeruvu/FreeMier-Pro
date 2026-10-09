
export function bindProjectEvents(ui) {
  ui.$('btn-import').addEventListener('click', async () => {
    const selectedBin = ui.$('media-bin-filter').value;
    const binId = selectedBin === '__root__' || selectedBin === '' ? null : selectedBin;
    const paths = await ui.api.pickMedia(); for (const path of paths ?? []) {
      const result = await ui.command('media_import', { path, binId });
      if (result)
        ui.toast('Imported ' + result.asset.name);
    }
  });
  ui.$('bin-search').addEventListener('input', () => ui.browser === 'project' ? void ui.queryMedia(true) : ui.renderMediaBin());
  ui.$('bin-view').addEventListener('click', () => ui.persistWorkspacePatch({ grid: !ui.grid }));
  ui.$('media-bin-filter').addEventListener('change', () => { void ui.refreshMediaBins(); void ui.queryMedia(true); });
  for (const id of ['media-kind-filter', 'media-sort'])
    ui.$(id).addEventListener('change', () => void ui.queryMedia(true));
  ui.$('media-page-prev').addEventListener('click', () => ui.pageMedia(-1));
  ui.$('media-page-next').addEventListener('click', () => ui.pageMedia(1));
  ui.$('media-bin-create').addEventListener('click', () => void ui.createMediaBin());
  ui.$('media-bin-create-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') void ui.createMediaBin(); });
  ui.$('media-bin-move').addEventListener('click', () => void ui.moveMediaBin());
  ui.$('media-bin-rename').addEventListener('click', () => void ui.renameMediaBin());
  ui.$('media-bin-remove').addEventListener('click', () => void ui.removeMediaBin());
  ui.$('media-selected-bin').addEventListener('change', async (event) => {
    const assetIds = ui.getSelectedMediaIds();
    if (!assetIds.length) return;
    const value = event.currentTarget.value;
    await ui.command('media_assign_bin', { assetIds, binId: value === '__root__' ? null : value });
  });
  ui.$('media-asset-name').addEventListener('change', () => void ui.saveMediaMetadata({ name: ui.$('media-asset-name').value.trim() }));
  ui.$('media-asset-description').addEventListener('change', () => void ui.saveMediaMetadata({ description: ui.$('media-asset-description').value }));
  ui.$('media-asset-tags').addEventListener('change', () => void ui.saveMediaMetadata({ tags: ui.$('media-asset-tags').value.split(',').map((tag) => tag.trim()).filter(Boolean) }));
  ui.$('media-asset-rating').addEventListener('change', () => void ui.saveMediaMetadata({ rating: Number(ui.$('media-asset-rating').value) }));
  ui.$('media-availability-refresh').addEventListener('click', () => void ui.refreshMediaAvailability());
  ui.$('media-relink-candidates').addEventListener('click', () => void ui.findRelinkCandidates());
  ui.$('media-relink-root').addEventListener('keydown', (event) => { if (event.key === 'Enter') void ui.findRelinkCandidates(); });
  ui.$('media-relink-apply').addEventListener('click', () => void ui.relinkSelected());
  ui.$('media-relink-accept-unverified').addEventListener('change', (event) => {
    ui.setUnverifiedConsent(event.currentTarget.checked ? ui.getSelectedMediaIds()[0] ?? null : null);
  });
  for (const button of document.querySelectorAll('[data-browser]'))
    button.addEventListener('click', () => { ui.$('bin-search').value = ''; ui.setWorkspaceBrowser(button.dataset.browser); });
}
