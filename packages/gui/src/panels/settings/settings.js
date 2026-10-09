import { DEFAULT_WORKSPACE_LAYOUT, patchWorkspaceLayout, validateStoredWorkspaceSettings, validateWorkspaceLayout } from '@freemier/shared/workspace';

const unwrap = (result) => result?.data ?? result;

/** Workspace preferences are an owned-service snapshot, never project state. */
export function registerPanelsSettings(ui) {
  let snapshot = null;
  let draftLayout = { ...DEFAULT_WORKSPACE_LAYOUT, panels: { ...DEFAULT_WORKSPACE_LAYOUT.panels } };
  let pendingPatch = null;
  let writeQueue = Promise.resolve();
  let settingsEpoch = null;
  let settingsRevision = -1;

  function setVisible(selector, visible) {
    const element = document.querySelector(selector);
    if (element) element.hidden = !visible;
  }

  function syncDialog(layout = draftLayout) {
    const priorLayoutId = ui.$('ws-layout-select').value;
    ui.$('ws-mode').value = layout.mode;
    ui.$('ws-browser').value = layout.browser;
    ui.$('ws-library-visible').checked = layout.panels.library;
    ui.$('ws-source-visible').checked = layout.panels.source;
    ui.$('ws-inspector-visible').checked = layout.panels.inspector;
    ui.$('ws-transitions-visible').checked = layout.panels.transitions;
    ui.$('ws-library-width').value = String(layout.libraryWidth);
    ui.$('ws-inspector-width').value = String(layout.inspectorWidth);
    ui.$('ws-source-ratio').value = String(layout.sourceRatio);
    ui.$('ws-source-ratio-value').textContent = `${Math.round(layout.sourceRatio * 100)}%`;
    ui.$('ws-auto-timeline-height').checked = layout.timelineHeight === null;
    ui.$('ws-timeline-height').disabled = layout.timelineHeight === null;
    ui.$('ws-timeline-height').value = String(layout.timelineHeight ?? 320);
    ui.$('ws-timeline-zoom').value = String(layout.timelineZoom);
    ui.$('ws-snap').checked = layout.snap;
    ui.$('ws-grid').checked = layout.grid;
    const readonly = Boolean(snapshot?.readOnly);
    ui.$('ws-persistence-warning').hidden = !readonly && !snapshot?.persistenceError;
    ui.$('ws-persistence-warning').textContent = readonly
      ? `Workspace settings are read-only${snapshot?.persistenceError ? `: ${snapshot.persistenceError}` : ' because the saved file could not be read'}. Restore defaults will back up the original file first.`
      : snapshot?.persistenceError ?? '';
    const hasLayouts = (snapshot?.layouts ?? []).length > 0;
    ui.$('ws-layout-select').replaceChildren(new Option('Choose a saved layout', ''), ...(snapshot?.layouts ?? []).map((layout) => new Option(layout.name, layout.id)));
    if ((snapshot?.layouts ?? []).some((layout) => layout.id === priorLayoutId)) ui.$('ws-layout-select').value = priorLayoutId;
    for (const id of ['ws-mode', 'ws-browser', 'ws-library-visible', 'ws-source-visible', 'ws-inspector-visible', 'ws-transitions-visible', 'ws-library-width', 'ws-inspector-width', 'ws-source-ratio', 'ws-auto-timeline-height', 'ws-timeline-height', 'ws-timeline-zoom', 'ws-snap', 'ws-grid', 'ws-layout-name', 'ws-layout-save', 'ws-layout-select', 'ws-layout-apply', 'ws-layout-delete'])
      ui.$(id).disabled = readonly;
    ui.$('ws-timeline-height').disabled = readonly || layout.timelineHeight === null;
    const selectedLayout = (snapshot?.layouts ?? []).some((layout) => layout.id === ui.$('ws-layout-select').value);
    ui.$('ws-layout-apply').disabled = readonly || !selectedLayout;
    ui.$('ws-layout-delete').disabled = readonly || !selectedLayout;
    ui.$('ws-restore').disabled = false;
    ui.$('workspace-mode-note').hidden = layout.panels.inspector;
  }

  function applyLayout(layout, { sync = true } = {}) {
    try { validateWorkspaceLayout(layout); } catch { return false; }
    const previousSourceVisible = draftLayout.panels.source;
    draftLayout = { ...layout, panels: { ...layout.panels } };
    ui.workspace = layout.mode;
    ui.browser = layout.browser;
    ui.snap = layout.snap;
    ui.grid = layout.grid;
    ui.pps = layout.timelineZoom;
    document.body.dataset.workspace = layout.mode;
    document.querySelectorAll('#workspace-tabs [data-workspace]').forEach((button) => button.classList.toggle('active', button.dataset.workspace === layout.mode));
    document.querySelectorAll('#left [data-browser]').forEach((button) => button.classList.toggle('active', button.dataset.browser === layout.browser));
    ui.$('bin-view').textContent = layout.grid ? '▦' : '☷';
    ui.$('btn-snap').classList.toggle('active', layout.snap);
    ui.$('timeline-zoom').value = String(layout.timelineZoom);
    const layoutElement = ui.$('layout');
    layoutElement.style.setProperty('--workspace-library-width', `${layout.libraryWidth}px`);
    layoutElement.style.setProperty('--workspace-inspector-width', `${layout.inspectorWidth}px`);
    layoutElement.dataset.libraryVisible = String(layout.panels.library);
    layoutElement.dataset.inspectorVisible = String(layout.panels.inspector);
    const monitors = ui.$('monitors');
    monitors.style.gridTemplateColumns = layout.panels.source ? `${layout.sourceRatio}fr ${1 - layout.sourceRatio}fr` : 'minmax(0,1fr)';
    monitors.dataset.sourceVisible = String(layout.panels.source);
    const timeline = ui.$('timeline-wrap');
    if (layout.timelineHeight === null) timeline.style.removeProperty('--workspace-timeline-height');
    else timeline.style.setProperty('--workspace-timeline-height', `${layout.timelineHeight}px`);
    setVisible('#left', layout.panels.library);
    setVisible('#source-monitor', layout.panels.source);
    setVisible('#right', layout.panels.inspector);
    setVisible('#transition-panel', layout.panels.transitions);
    if (previousSourceVisible && !layout.panels.source) {
      ui.sourcePlaying = false;
      ui.sourceFocused = false;
      ui.sourceEl?.pause?.();
      ui.updateSource?.();
    }
    if (ui.project) {
      ui.renderMediaBin?.();
      ui.renderInspector?.();
      ui.renderTransitionsPanel?.();
    }
    ui.$('timeline-zoom').dispatchEvent(new Event('workspace-layout', { bubbles: false }));
    ui.renderTimeline?.();
    ui.drawProgram?.();
    if (sync) syncDialog();
    return true;
  }

  function receiveWorkspaceSettings(incoming, authority = false) {
    const value = incoming?.workspaceSettings ?? incoming;
    if (!value || typeof value !== 'object' || typeof value.epoch !== 'string' || !value.epoch || typeof value.readOnly !== 'boolean') return false;
    try { validateStoredWorkspaceSettings({ version: value.version, revision: value.revision, current: value.current, layouts: value.layouts }); } catch { return false; }
    if (settingsEpoch === null) {
      if (!authority) return false;
      settingsEpoch = value.epoch;
      settingsRevision = value.revision;
    } else if (value.epoch !== settingsEpoch) {
      if (!authority) return false;
      settingsEpoch = value.epoch;
      settingsRevision = value.revision;
    } else {
      if (value.revision < settingsRevision || value.revision === settingsRevision) return false;
      settingsRevision = value.revision;
    }
    snapshot = value;
    ui.workspaceSettings = value;
    applyLayout(value.current);
    if (value.readOnly) pendingPatch = null;
    if (pendingPatch) {
      draftLayout = patchWorkspaceLayout(value.current, pendingPatch);
      applyLayout(draftLayout);
      void queuePendingWrites();
    }
    syncDialog(draftLayout);
    ui.$('btn-workspace-settings').dataset.settingsRevision = String(value.revision);
    return true;
  }

  function snapshotFromResult(result) {
    const value = unwrap(result);
    return value?.workspaceSettings ?? value?._bridge?.workspaceSettings ?? result?._bridge?.workspaceSettings;
  }

  async function sendPatch(patch) {
    const base = snapshot;
    if (!base || base.readOnly) return;
    const result = await ui.command('workspace_settings_update', { patch });
    const next = snapshotFromResult(result);
    if (next) receiveWorkspaceSettings(next, false);
    if (!result || !next) {
      if (base.epoch === settingsEpoch) applyLayout(snapshot?.current ?? base.current);
      return;
    }
    if (next.epoch !== settingsEpoch) return;
  }

  function queuePendingWrites() {
    writeQueue = writeQueue.then(async () => {
      while (pendingPatch && snapshot && !snapshot.readOnly) {
        const patch = pendingPatch;
        pendingPatch = null;
        await sendPatch(patch);
        if (pendingPatch) {
          draftLayout = patchWorkspaceLayout(snapshot?.current ?? draftLayout, pendingPatch);
          applyLayout(draftLayout);
        }
      }
    }).catch((error) => ui.toast(error.message, 'error'));
    return writeQueue;
  }

  function persistWorkspacePatch(patch, { commit = true } = {}) {
    let nextLayout;
    try { nextLayout = patchWorkspaceLayout(draftLayout, patch); } catch (error) { ui.toast(error.message, 'error'); return; }
    applyLayout(nextLayout);
    if (!commit) return;
    if (snapshot?.readOnly) {
      applyLayout(snapshot.current);
      ui.toast('Workspace settings are read-only. Restore defaults to recover the saved file.', 'error');
      return;
    }
    pendingPatch = { ...(pendingPatch ?? {}), ...patch, ...(patch.panels ? { panels: { ...(pendingPatch?.panels ?? {}), ...patch.panels } } : {}) };
    if (snapshot) void queuePendingWrites();
  }

  async function runAction(action, args = {}, expectedRevision = true) {
    await queuePendingWrites();
    const result = await ui.command(action, { ...args, ...(expectedRevision && snapshot ? { expectedSettingsRevision: snapshot.revision } : {}) });
    const next = snapshotFromResult(result);
    if (next) receiveWorkspaceSettings(next, false);
    return unwrap(result);
  }

  async function refreshWorkspaceSettings(authority = true) {
    const result = await ui.command('workspace_settings_get');
    const next = snapshotFromResult(result);
    if (next) receiveWorkspaceSettings(next, authority);
    return next;
  }

  async function loadLayouts() {
    const result = await runAction('workspace_layout_list', {}, false);
    const next = result?.workspaceSettings;
    if (next) receiveWorkspaceSettings(next, false);
  }

  function setMode(mode) { persistWorkspacePatch({ mode }); }
  function setBrowser(browser) { persistWorkspacePatch({ browser }); }

  ui.$('btn-workspace-settings').addEventListener('click', async () => {
    syncDialog();
    ui.$('workspace-settings-dialog').showModal();
    await loadLayouts();
    syncDialog();
  });
  ui.$('workspace-settings-close').addEventListener('click', () => ui.$('workspace-settings-dialog').close());
  ui.$('ws-mode').addEventListener('change', () => persistWorkspacePatch({ mode: ui.$('ws-mode').value }));
  ui.$('ws-browser').addEventListener('change', () => persistWorkspacePatch({ browser: ui.$('ws-browser').value }));
  for (const key of ['library', 'source', 'inspector', 'transitions'])
    ui.$(`ws-${key}-visible`).addEventListener('change', (event) => persistWorkspacePatch({ panels: { [key]: event.currentTarget.checked } }));
  ui.$('ws-library-width').addEventListener('input', () => applyLayout(patchWorkspaceLayout(draftLayout, { libraryWidth: Number(ui.$('ws-library-width').value) })));
  ui.$('ws-library-width').addEventListener('change', () => persistWorkspacePatch({ libraryWidth: Number(ui.$('ws-library-width').value) }));
  ui.$('ws-inspector-width').addEventListener('input', () => applyLayout(patchWorkspaceLayout(draftLayout, { inspectorWidth: Number(ui.$('ws-inspector-width').value) })));
  ui.$('ws-inspector-width').addEventListener('change', () => persistWorkspacePatch({ inspectorWidth: Number(ui.$('ws-inspector-width').value) }));
  ui.$('ws-source-ratio').addEventListener('input', () => { const value = Number(ui.$('ws-source-ratio').value); ui.$('ws-source-ratio-value').textContent = `${Math.round(value * 100)}%`; applyLayout(patchWorkspaceLayout(draftLayout, { sourceRatio: value })); });
  ui.$('ws-source-ratio').addEventListener('change', () => persistWorkspacePatch({ sourceRatio: Number(ui.$('ws-source-ratio').value) }));
  ui.$('ws-auto-timeline-height').addEventListener('change', (event) => {
    ui.$('ws-timeline-height').disabled = event.currentTarget.checked;
    persistWorkspacePatch({ timelineHeight: event.currentTarget.checked ? null : Number(ui.$('ws-timeline-height').value) });
  });
  ui.$('ws-timeline-height').addEventListener('input', () => applyLayout(patchWorkspaceLayout(draftLayout, { timelineHeight: Number(ui.$('ws-timeline-height').value) })));
  ui.$('ws-timeline-height').addEventListener('change', () => persistWorkspacePatch({ timelineHeight: Number(ui.$('ws-timeline-height').value) }));
  ui.$('ws-timeline-zoom').addEventListener('input', () => applyLayout(patchWorkspaceLayout(draftLayout, { timelineZoom: Number(ui.$('ws-timeline-zoom').value) })));
  ui.$('ws-timeline-zoom').addEventListener('change', () => persistWorkspacePatch({ timelineZoom: Number(ui.$('ws-timeline-zoom').value) }));
  ui.$('ws-snap').addEventListener('change', () => persistWorkspacePatch({ snap: ui.$('ws-snap').checked }));
  ui.$('ws-grid').addEventListener('change', () => persistWorkspacePatch({ grid: ui.$('ws-grid').checked }));
  ui.$('ws-layout-save').addEventListener('click', async () => {
    const result = await runAction('workspace_layout_save', { name: ui.$('ws-layout-name').value });
    if (result?.layoutId) { ui.$('ws-layout-name').value = ''; ui.toast('Workspace layout saved'); syncDialog(); }
  });
  ui.$('ws-layout-apply').addEventListener('click', async () => {
    const layoutId = ui.$('ws-layout-select').value;
    if (!layoutId) return;
    const result = await runAction('workspace_layout_apply', { layoutId });
    if (result?.workspaceSettings) ui.toast('Workspace layout applied');
  });
  ui.$('ws-layout-delete').addEventListener('click', async () => {
    const layoutId = ui.$('ws-layout-select').value;
    if (!layoutId) return;
    const result = await runAction('workspace_layout_delete', { layoutId });
    if (result?.workspaceSettings) ui.toast('Workspace layout deleted');
  });
  ui.$('ws-restore').addEventListener('click', async () => {
    await queuePendingWrites();
    const result = await runAction('workspace_settings_reset');
    if (result?.workspaceSettings) ui.toast('Workspace settings restored to defaults');
  });
  ui.$('ws-layout-select').addEventListener('change', () => {
    const selected = (snapshot?.layouts ?? []).some((layout) => layout.id === ui.$('ws-layout-select').value);
    ui.$('ws-layout-apply').disabled = Boolean(snapshot?.readOnly) || !selected;
    ui.$('ws-layout-delete').disabled = Boolean(snapshot?.readOnly) || !selected;
  });

  Object.assign(ui, { receiveWorkspaceSettings, refreshWorkspaceSettings, persistWorkspacePatch, setWorkspaceMode: setMode, setWorkspaceBrowser: setBrowser });
  applyLayout(draftLayout);
}
