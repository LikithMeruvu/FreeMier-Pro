import { EFFECT_CATALOG } from '@freemier/shared/effects';

export function registerPanelsProjectBrowser(ui) {
  // Project bin and source monitor stay independent of sequence selection.
  function renderMediaBin() {
    if (!ui.project)
      return;
    const query = ui.$('bin-search').value.toLowerCase();
    ui.$('media-bin').hidden = ui.browser !== 'project';
    ui.$('effects-browser').hidden = ui.browser !== 'effects';
    ui.$('markers-panel').hidden = ui.browser !== 'markers';
    ui.$('presets-panel').hidden = ui.browser !== 'presets';
    ui.renderPresets(query);
    ui.$('bin-search').placeholder = ui.browser === 'project' ? 'Search media' : ui.browser === 'effects' ? 'Search effects' : 'Search markers';
    ui.$('bin-search').setAttribute('aria-label', ui.$('bin-search').placeholder);
    ui.$('media-bin').className = 'media-bin ' + (ui.grid ? 'grid' : 'list');
    const assets = ui.project.media.filter((a) => a.name.toLowerCase().includes(query));
    ui.$('bin-count').textContent = (ui.browser === 'project' ? assets.length : ui.browser === 'effects' ? EFFECT_CATALOG.filter((e) => e.name.toLowerCase().includes(query)).length : (ui.project.timeline.markers ?? []).filter((m) => (m.label + ' ' + m.notes).toLowerCase().includes(query)).length) + ' items';
    ui.renderMarkers(query);
    ui.$('titles-panel').hidden = ui.browser !== 'titles';
    ui.renderTitles(query);
    ui.$('captions-panel').hidden = ui.browser !== 'captions';
    ui.renderCaptions(query);
    if (ui.browser === 'titles') {
      ui.$('bin-search').placeholder = 'Search titles';
      ui.$('bin-count').textContent = (ui.project.timeline.titles ?? []).filter((t) => t.text.toLowerCase().includes(query)).length + ' items';
    }
    if (ui.browser === 'captions') {
      ui.$('bin-search').placeholder = 'Search captions';
      ui.$('bin-count').textContent = (ui.project.timeline.captions?.cues ?? []).filter((c) => c.text.toLowerCase().includes(query)).length + ' cues';
    }
    if (ui.browser === 'presets') {
      ui.$('bin-search').placeholder = 'Search presets';
      ui.$('bin-count').textContent = ui.filteredPresets(query).length + ' presets';
    }
    ui.$('media-bin').replaceChildren(...assets.map((asset) => {
      const item = ui.node('div', 'media-item' + (asset.id === ui.sourceAssetId ? ' selected' : ''));
      item.dataset.assetId = asset.id;
      item.draggable = true;
      item.tabIndex = 0;
      const img = ui.node('img', 'media-thumb');
      img.alt = asset.name;
      if (ui.thumbs.has(asset.id))
        img.src = ui.thumbs.get(asset.id);
      else
        void ui.thumbnail(asset, img);
      const meta = ui.node('div', 'media-meta');
      meta.append(ui.node('div', 'media-name', asset.name), ui.node('div', 'media-sub', ui.tc(asset.duration) + ' · ' + asset.kind.toUpperCase()));
      item.append(img, meta);
      item.addEventListener('dblclick', () => ui.openSource(asset.id));
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')
          ui.openSource(asset.id);
      });
      item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-freemier-asset', asset.id); e.dataTransfer.setData('text/plain', asset.id); e.dataTransfer.effectAllowed = 'copy'; });
      return item;
    }));
    if (!assets.length)
      ui.$('media-bin').append(ui.node('div', 'empty', 'Import media to begin. Double-click a tile to inspect its source; drag it onto a track to edit.'));
    ui.renderEffectBrowser(query);
  }

  async function thumbnail(asset, img) {
    try {
      if (asset.kind === 'audio')
        return;
      if (asset.kind === 'image') {
        img.crossOrigin = 'anonymous';
        img.src = ui.mediaUrl(asset);
        ui.thumbs.set(asset.id, img.src);
        return;
      }
      if (!ui.pendingThumbs.has(asset.id))
        ui.pendingThumbs.set(asset.id, fetch(ui.BRIDGE + '/thumbnail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: asset.id }) }).then((r) => r.json()));
      const result = await ui.pendingThumbs.get(asset.id);
      if (result.ok) {
        ui.thumbs.set(asset.id, result.dataUrl);
        img.src = result.dataUrl;
      }
    }
    catch { }
  }
  Object.assign(ui, { renderMediaBin, thumbnail });
}
