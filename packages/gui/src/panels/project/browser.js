import { EFFECT_CATALOG } from '@freemier/shared/effects';

const ROOT_BIN = '__root__';
const unwrap = (result) => result?.data ?? result;
const mediaLocationKey = (asset) => `${asset.copied ? 'copied' : 'referenced'}\0${asset.path}\0${asset.sourceIdentity?.sha256 ?? ''}\0${asset.sourceIdentity?.size ?? ''}`;

export function registerPanelsProjectBrowser(ui) {
  let queryGeneration = 0;
  let binsGeneration = 0;
  let availabilityGeneration = 0;
  let candidatesGeneration = 0;
  let selectedAssetIds = new Set();
  let metadataByAsset = new Map();
  let availabilityByAsset = new Map();
  let assetPaths = new Map();
  let unverifiedConsentAssetId = null;
  let queryOffset = 0;
  const queryPageSize = 100;
  let lastQueryRevision = -1;
  let candidateByPath = new Map();
  let currentProjectId = null;

  async function readCommand(action, args = {}) {
    try {
      const response = await fetch(ui.BRIDGE + '/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...args }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error?.message ?? `${action} failed`);
      return result;
    }
    catch (error) {
      ui.toast(error.message, 'error');
      return null;
    }
  }

  function selectedAsset() {
    const id = [...selectedAssetIds][0];
    return ui.project?.media.find((asset) => asset.id === id) ?? null;
  }

  function getSelectedMediaIds() {
    return [...selectedAssetIds];
  }

  function setUnverifiedConsent(assetId) {
    unverifiedConsentAssetId = assetId;
    renderSelectedControls();
  }

  function pageMedia(direction) {
    queryOffset = Math.max(0, queryOffset + direction * queryPageSize);
    void queryMedia(false);
  }

  function metadataFor(asset) {
    return metadataByAsset.get(asset.id) ?? { binId: null, description: '', tags: [], rating: 0 };
  }

  function renderBinControls(bins) {
    const filter = ui.$('media-bin-filter');
    const parent = ui.$('media-bin-parent');
    const assignment = ui.$('media-selected-bin');
    const priorFilter = filter.value;
    const priorParent = parent.value;
    const priorAssignment = assignment.value;
    const optionNodes = [new Option('All media', ''), new Option('Root bin', ROOT_BIN)];
    const assignmentNodes = [new Option('Root bin', ROOT_BIN)];
    const parentNodes = [new Option('Root bin', ROOT_BIN)];
    const sorted = [...bins].sort((a, b) => a.name.localeCompare(b.name));
    const children = (id) => sorted.filter((bin) => (bin.parentId ?? null) === id);
    const walk = (parentId, depth, ancestors) => {
      for (const bin of children(parentId)) {
        if (ancestors.has(bin.id)) continue;
        const label = '　'.repeat(depth) + bin.name;
        optionNodes.push(new Option(label, bin.id));
        assignmentNodes.push(new Option(label, bin.id));
        parentNodes.push(new Option(label, bin.id));
        walk(bin.id, depth + 1, new Set([...ancestors, bin.id]));
      }
    };
    walk(null, 0, new Set());
    filter.replaceChildren(...optionNodes);
    parent.replaceChildren(...parentNodes);
    assignment.replaceChildren(...assignmentNodes);
    if ([...filter.options].some((option) => option.value === priorFilter)) filter.value = priorFilter;
    if ([...parent.options].some((option) => option.value === priorParent)) parent.value = priorParent;
    const current = selectedAsset() ? metadataFor(selectedAsset()).binId ?? null : null;
    assignment.value = [...assignment.options].some((option) => option.value === (current ?? ROOT_BIN)) ? (current ?? ROOT_BIN) : ROOT_BIN;
    const tree = ui.$('media-bin-tree');
    const rows = [];
    const rowWalk = (parentId, depth, ancestors) => {
      for (const bin of children(parentId)) {
        if (ancestors.has(bin.id)) continue;
        const row = ui.node('div', 'media-bin-tree-row');
        row.style.setProperty('--bin-depth', String(depth));
        const choose = ui.button(bin.name, 'Filter to bin ' + bin.name, () => { filter.value = bin.id; filter.dispatchEvent(new Event('change')); });
        choose.classList.toggle('active', filter.value === bin.id);
        choose.classList.add('media-bin-tree-select');
        row.append(choose);
        if (filter.value === bin.id) row.dataset.selected = 'true';
        rows.push(row);
        rowWalk(bin.id, depth + 1, new Set([...ancestors, bin.id]));
      }
    };
    rowWalk(null, 0, new Set());
    tree.replaceChildren(...rows);
    ui.$('media-bin-summary').textContent = bins.length ? `(${bins.length})` : '(none)';
    ui.$('media-bin-rename').disabled = !bins.some((bin) => bin.id === filter.value);
    ui.$('media-bin-remove').disabled = !bins.some((bin) => bin.id === filter.value);
  }

  async function refreshBins() {
    const generation = ++binsGeneration;
    const project = ui.project;
    const projectId = project?.id;
    const revision = ui.revision;
    if (!projectId) return;
    const response = unwrap(await readCommand('media_bins'));
    if (generation !== binsGeneration || ui.project !== project || ui.project?.id !== projectId || ui.revision !== revision || !response || response.revision !== undefined && response.revision !== revision || !Array.isArray(response.bins)) return;
    ui.mediaBins = response.bins;
    renderBinControls(response.bins);
  }

  function renderSelectedControls() {
    const asset = selectedAsset();
    const section = ui.$('media-selection-controls');
    section.hidden = !asset;
    if (!asset) return;
    const metadata = metadataFor(asset);
    ui.$('media-selected-label').textContent = asset.name;
    ui.$('media-asset-name').value = asset.name;
    ui.$('media-asset-description').value = metadata.description ?? '';
    ui.$('media-asset-tags').value = (metadata.tags ?? []).join(', ');
    ui.$('media-asset-rating').value = String(metadata.rating ?? 0);
    ui.$('media-selected-bin').value = metadata.binId ?? ROOT_BIN;
    const observation = availabilityByAsset.get(asset.id);
    const status = ui.$('media-availability-status');
    status.textContent = observation ? `${observation.status}${observation.reason ? ` · ${observation.reason}` : ''}` : 'Path status not checked';
    status.className = 'media-availability-status' + (observation?.status && observation.status !== 'available' ? ' unavailable' : '');
    const needsRelink = observation?.status === 'missing' || observation?.status === 'changed' || observation?.status === 'inaccessible' || !asset.sourceIdentity;
    ui.$('media-relink-apply').disabled = !needsRelink;
    ui.$('media-relink-accept-unverified').disabled = Boolean(asset.sourceIdentity);
    ui.$('media-relink-accept-unverified').checked = unverifiedConsentAssetId === asset.id;
  }

  function renderCards(assets, total = assets.length) {
    const container = ui.$('media-bin');
    container.replaceChildren(...assets.map(({ asset, binId, description, tags, rating, availability }) => {
      const locationKey = mediaLocationKey(asset);
      const previousPath = assetPaths.get(asset.id);
      if (previousPath !== undefined && previousPath !== locationKey) {
        availabilityByAsset.delete(asset.id);
        ui.thumbs.delete(asset.id);
        ui.pendingThumbs.delete(asset.id);
        candidateByPath.clear();
        candidatesGeneration++;
      }
      assetPaths.set(asset.id, locationKey);
      metadataByAsset.set(asset.id, { binId: binId ?? null, description: description ?? '', tags: tags ?? [], rating: rating ?? 0 });
      if (availability) availabilityByAsset.set(asset.id, availability);
      const observation = availabilityByAsset.get(asset.id);
      const selected = selectedAssetIds.has(asset.id);
      const isSource = asset.id === ui.sourceAssetId;
      const item = ui.node('div', 'media-item' + (isSource ? ' source-selected' : '') + (selected || isSource ? ' selected' : ''));
      item.dataset.assetId = asset.id;
      item.draggable = true;
      item.tabIndex = 0;
      item.setAttribute('aria-label', `${asset.name}${observation && observation.status !== 'available' ? `, ${observation.status}` : ''}`);
      const img = ui.node('img', 'media-thumb');
      img.alt = asset.name;
      if (ui.thumbs.has(asset.id)) img.src = ui.thumbs.get(asset.id);
      else void ui.thumbnail(asset, img);
      const meta = ui.node('div', 'media-meta');
      meta.append(ui.node('div', 'media-name', asset.name), ui.node('div', 'media-sub', `${ui.tc(asset.duration)} · ${asset.kind.toUpperCase()}`));
      if (observation && observation.status !== 'available') {
        const badge = ui.node('span', 'media-offline-badge', observation.status === 'missing' ? 'OFFLINE' : observation.status.toUpperCase());
        badge.title = observation.reason ?? observation.status;
        meta.append(badge);
      }
      if (rating) meta.append(ui.node('span', 'media-rating-badge', '★'.repeat(rating)));
      item.append(img, meta);
      item.addEventListener('click', (event) => {
        const previousSelectedAssetId = [...selectedAssetIds][0] ?? null;
        if (!event.ctrlKey && !event.metaKey) selectedAssetIds = new Set();
        if (selectedAssetIds.has(asset.id) && (event.ctrlKey || event.metaKey)) selectedAssetIds.delete(asset.id);
        else selectedAssetIds.add(asset.id);
        if (previousSelectedAssetId !== asset.id) {
          unverifiedConsentAssetId = null;
          candidateByPath.clear();
          ui.$('media-relink-path').value = '';
          ui.$('media-relink-candidate-list').replaceChildren();
        }
        renderSelectedControls();
        for (const card of container.querySelectorAll('.media-item')) card.classList.toggle('selected', selectedAssetIds.has(card.dataset.assetId) || card.dataset.assetId === ui.sourceAssetId);
      });
      item.addEventListener('dblclick', () => ui.openSource(asset.id));
      item.addEventListener('keydown', (event) => { if (event.key === 'Enter') ui.openSource(asset.id); });
      item.addEventListener('dragstart', (event) => { event.dataTransfer.setData('application/x-freemier-asset', asset.id); event.dataTransfer.setData('text/plain', asset.id); event.dataTransfer.effectAllowed = 'copy'; });
      return item;
    }));
    if (!assets.length) container.append(ui.node('div', 'empty', 'No matching media. Import media to begin, or change the search and filters.'));
    ui.$('bin-count').textContent = `${total} items`;
    renderSelectedControls();
  }

  async function queryMedia(resetPage = false) {
    if (!ui.project) return;
    if (resetPage) queryOffset = 0;
    const generation = ++queryGeneration;
    const project = ui.project;
    const projectId = project.id;
    const revision = ui.revision;
    const [text, sort] = [ui.$('bin-search').value.trim(), ui.$('media-sort').value.split(':')];
    const binValue = ui.$('media-bin-filter').value;
    const args = {
      ...(text ? { text } : {}),
      ...(binValue ? { binId: binValue === ROOT_BIN ? null : binValue, includeChildren: true } : {}),
      ...(ui.$('media-kind-filter').value ? { kind: ui.$('media-kind-filter').value } : {}),
      sortBy: sort[0], sortDirection: sort[1], limit: queryPageSize, offset: queryOffset,
    };
    const response = unwrap(await readCommand('media_query', args));
    if (generation !== queryGeneration || ui.project !== project || ui.project?.id !== projectId || ui.revision !== revision || !response || response.revision !== undefined && response.revision !== revision || !Array.isArray(response.assets)) return;
    const total = response.total ?? response.assets.length;
    if (queryOffset >= total && total > 0) {
      queryOffset = Math.floor((total - 1) / queryPageSize) * queryPageSize;
      void queryMedia(false);
      return;
    }
    lastQueryRevision = response.revision ?? revision;
    ui.$('media-bin').dataset.queryRevision = String(lastQueryRevision);
    ui.$('media-bin').dataset.queryGeneration = String(generation);
    ui.$('media-bin').dataset.querySort = `${sort[0]}:${sort[1]}`;
    renderCards(response.assets, total);
    const first = total ? queryOffset + 1 : 0;
    const last = Math.min(queryOffset + response.assets.length, total);
    ui.$('media-page-info').textContent = `${first}–${last} of ${total}`;
    ui.$('media-page-prev').disabled = queryOffset <= 0;
    ui.$('media-page-next').disabled = queryOffset + response.assets.length >= total;
  }

  function renderMediaBin() {
    if (!ui.project) return;
    if (currentProjectId !== ui.project.id) {
      currentProjectId = ui.project.id;
      queryGeneration++;
      binsGeneration++;
      availabilityGeneration++;
      candidatesGeneration++;
      selectedAssetIds = new Set();
      metadataByAsset.clear();
      availabilityByAsset.clear();
      assetPaths.clear();
      candidateByPath.clear();
      unverifiedConsentAssetId = null;
      queryOffset = 0;
    }
    const query = ui.$('bin-search').value.toLowerCase();
    ui.$('media-bin').hidden = ui.browser !== 'project';
    ui.$('media-library-controls').hidden = ui.browser !== 'project';
    ui.$('effects-browser').hidden = ui.browser !== 'effects';
    ui.$('markers-panel').hidden = ui.browser !== 'markers';
    ui.$('presets-panel').hidden = ui.browser !== 'presets';
    ui.renderPresets(query);
    ui.$('bin-search').placeholder = ui.browser === 'project' ? 'Search media' : ui.browser === 'effects' ? 'Search effects' : 'Search markers';
    ui.$('bin-search').setAttribute('aria-label', ui.$('bin-search').placeholder);
    ui.$('media-bin').className = 'media-bin ' + (ui.grid ? 'grid' : 'list');
    if (ui.browser === 'effects')
      ui.$('bin-count').textContent = EFFECT_CATALOG.filter((effect) => effect.name.toLowerCase().includes(query)).length + ' items';
    else if (ui.browser === 'markers')
      ui.$('bin-count').textContent = (ui.project.timeline.markers ?? []).filter((marker) => (marker.label + ' ' + marker.notes).toLowerCase().includes(query)).length + ' items';
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
    if (ui.browser === 'project') {
      void refreshBins();
      void queryMedia();
    }
    ui.renderEffectBrowser(query);
  }

  async function saveMetadata(patch) {
    const assets = [...selectedAssetIds];
    if (assets.length !== 1) { ui.toast('Select one asset to edit its metadata'); return; }
    const assetId = assets[0];
    const response = unwrap(await ui.command('media_metadata_update', { assetId, ...patch }));
    if (response) {
      const asset = ui.project?.media.find((item) => item.id === assetId);
      if (asset) metadataByAsset.set(assetId, { ...metadataFor(asset), ...patch, tags: patch.tags ?? metadataFor(asset).tags });
      renderSelectedControls();
    }
  }

  async function refreshAvailability() {
    const generation = ++availabilityGeneration;
    const project = ui.project;
    const projectId = project?.id;
    const revision = ui.revision;
    const assetIds = [...selectedAssetIds];
    const response = unwrap(await readCommand('media_availability', { ...(assetIds.length ? { assetIds } : {}), verify: true }));
    if (generation !== availabilityGeneration || ui.project !== project || ui.project?.id !== projectId || ui.revision !== revision || !response || response.stale || response.revision !== undefined && response.revision !== revision || !Array.isArray(response.observations)) return;
    for (const observation of response.observations) availabilityByAsset.set(observation.assetId, observation);
    if (response.observations.length) {
      ui.toast(`Checked ${response.observations.length} media path${response.observations.length === 1 ? '' : 's'}`);
      renderSelectedControls();
      void queryMedia();
    }
  }

  async function findRelinkCandidates() {
    const asset = selectedAsset();
    const root = ui.$('media-relink-root').value.trim();
    if (!asset || !root) { ui.toast('Select one asset and enter a search root path', 'error'); return; }
    const generation = ++candidatesGeneration;
    const project = ui.project;
    const projectId = project?.id;
    const revision = ui.revision;
    const assetId = asset.id;
    const assetPath = asset.path;
    const response = unwrap(await readCommand('find_relink_candidates', { assetId: asset.id, roots: [root] }));
    if (generation !== candidatesGeneration || ui.project !== project || ui.project?.id !== projectId || ui.revision !== revision || selectedAsset()?.id !== assetId || ui.project?.media.find((item) => item.id === assetId)?.path !== assetPath || !response || response.stale || response.revision !== undefined && response.revision !== revision || !Array.isArray(response.candidates)) return;
    candidateByPath = new Map(response.candidates.map((candidate) => [candidate.path, candidate]));
    const list = ui.$('media-relink-candidate-list');
    list.replaceChildren(...response.candidates.map((candidate) => {
      const button = ui.button(`${candidate.match === 'exact' ? 'Exact hash' : 'Unverified'} · ${candidate.path}`, 'Use this explicit relink candidate', () => {
        ui.$('media-relink-path').value = candidate.path;
        ui.$('media-relink-accept-unverified').checked = false;
        list.querySelectorAll('button').forEach((element) => element.classList.toggle('active', element === button));
      });
      button.className = 'media-relink-candidate';
      button.dataset.match = candidate.match;
      return button;
    }));
    if (response.truncated) list.append(ui.node('div', 'media-library-note', 'Search reached a safety limit. Narrow the explicit root and search again.'));
    if (!response.candidates.length) list.append(ui.node('div', 'media-library-note', 'No compatible candidates found.'));
    if (response.candidates.length) ui.toast(`${response.candidates.length} candidate${response.candidates.length === 1 ? '' : 's'} found; choose one explicitly`);
  }

  async function relinkSelected() {
    const asset = selectedAsset();
    const path = ui.$('media-relink-path').value.trim();
    if (!asset || !path) { ui.toast('Select one asset and provide a replacement path', 'error'); return; }
    const candidate = candidateByPath.get(path);
    if (candidate?.match === 'unverified' && !ui.$('media-relink-accept-unverified').checked) {
      ui.toast('This candidate has no verified content hash. Check the consent box after confirming the source.', 'error'); return;
    }
    const result = unwrap(await ui.command('media_relink', {
      assetId: asset.id, path, expectedRevision: ui.revision,
      ...(ui.$('media-relink-accept-unverified').checked && unverifiedConsentAssetId === asset.id ? { acceptUnverified: true } : {}),
    }));
    if (result?.asset) {
      ui.$('media-relink-path').value = '';
      candidateByPath.delete(path);
      availabilityByAsset.delete(asset.id);
      assetPaths.delete(asset.id);
      ui.thumbs.delete(asset.id);
      ui.pendingThumbs.delete(asset.id);
      ui.toast('Media relinked');
      void refreshAvailability();
    }
  }

  async function createBin() {
    const name = ui.$('media-bin-create-name').value.trim();
    if (!name) return;
    const parentId = ui.$('media-bin-parent').value;
    const result = unwrap(await ui.command('media_bin_create', { name, ...(parentId && parentId !== ROOT_BIN ? { parentId } : {}) }));
    const bin = result?.bin ?? result;
    if (bin?.id) {
      ui.$('media-bin-create-name').value = '';
      await refreshBins();
      if ((ui.mediaBins ?? []).some((item) => item.id === bin.id)) {
        ui.$('media-bin-filter').value = bin.id;
        renderBinControls(ui.mediaBins);
        void queryMedia(true);
      }
    }
  }

  async function renameBin() {
    const binId = ui.$('media-bin-filter').value;
    const bin = (ui.mediaBins ?? []).find((item) => item.id === binId);
    if (!bin) return;
    const name = window.prompt('Rename bin', bin.name);
    if (name?.trim()) { await ui.command('media_bin_update', { binId, name: name.trim() }); await refreshBins(); }
  }

  async function moveBin() {
    const binId = ui.$('media-bin-filter').value;
    const parentValue = ui.$('media-bin-parent').value;
    if (!binId) return;
    const result = await ui.command('media_bin_update', { binId, parentId: parentValue === ROOT_BIN ? null : parentValue || null });
    if (result) await refreshBins();
  }

  async function removeBin() {
    const binId = ui.$('media-bin-filter').value;
    const bin = (ui.mediaBins ?? []).find((item) => item.id === binId);
    if (!bin || !window.confirm(`Remove empty bin “${bin.name}”?`)) return;
    const result = await ui.command('media_bin_delete', { binId });
    if (result) { ui.$('media-bin-filter').value = ''; await refreshBins(); void queryMedia(); }
  }

  async function thumbnail(asset, img) {
    const projectId = ui.project?.id;
    const location = mediaLocationKey(asset);
    let pending;
    try {
      if (asset.kind === 'audio') return;
      if (asset.kind === 'image') {
        img.crossOrigin = 'anonymous';
        img.src = ui.mediaUrl(asset);
        ui.thumbs.set(asset.id, img.src);
        return;
      }
      if (!ui.pendingThumbs.has(asset.id))
        ui.pendingThumbs.set(asset.id, fetch(ui.BRIDGE + '/thumbnail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: asset.id }) }).then((response) => response.json()));
      pending = ui.pendingThumbs.get(asset.id);
      const result = await pending;
      const currentAsset = ui.project?.media.find((item) => item.id === asset.id);
      if (ui.pendingThumbs.get(asset.id) !== pending) return;
      if (ui.project?.id !== projectId || !currentAsset || mediaLocationKey(currentAsset) !== location) {
        ui.pendingThumbs.delete(asset.id);
        return;
      }
      if (result.ok && result.dataUrl) {
        ui.thumbs.set(asset.id, result.dataUrl);
        img.src = result.dataUrl;
      }
      else ui.pendingThumbs.delete(asset.id);
    }
    catch {
      // An older failed request must not evict a newer request for this asset.
      if (pending && ui.pendingThumbs.get(asset.id) === pending)
        ui.pendingThumbs.delete(asset.id);
    }
  }

  Object.assign(ui, {
    renderMediaBin, queryMedia, pageMedia, getSelectedMediaIds, setUnverifiedConsent, refreshMediaBins: refreshBins, thumbnail, saveMediaMetadata: saveMetadata,
    refreshMediaAvailability: refreshAvailability, findRelinkCandidates, relinkSelected,
    createMediaBin: createBin, renameMediaBin: renameBin, moveMediaBin: moveBin, removeMediaBin: removeBin,
  });
}
