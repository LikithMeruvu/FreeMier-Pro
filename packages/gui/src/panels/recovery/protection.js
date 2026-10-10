const unwrap = (result) => result?.data ?? result;

/** Project protection is presented here; all editable state stays in the owning service. */
export function registerProjectProtection(ui) {
  let snapshot = null;
  let ownerEpoch = null;
  let sequence = -1;
  let recoveries = [];
  let startupChooserChecked = false;
  let inspection = null;
  let recoveryRequest = 0;
  let inspectionRequest = 0;

  function commandSnapshot(result) {
    const value = unwrap(result);
    return value?.projectProtection ?? value?._bridge?.projectProtection ?? result?.projectProtection ?? result?._bridge?.projectProtection;
  }

  function commandOwnerEpoch(result) {
    const value = unwrap(result);
    return value?.eventEpoch ?? value?._bridge?.eventEpoch ?? result?._bridge?.eventEpoch;
  }

  function showError(message) {
    const error = ui.$('protection-error');
    error.hidden = !message;
    error.textContent = message ?? '';
  }

  function renderSnapshot() {
    if (!snapshot) return;
    const indicator = ui.$('protection-indicator');
    indicator.textContent = snapshot.dirty ? 'Unsaved' : snapshot.savedTo ? 'Saved' : 'New project';
    ui.$('btn-protection').dataset.dirty = String(snapshot.dirty);
    ui.$('btn-protection').dataset.error = String(Boolean(snapshot.recoveryError || snapshot.configurationError || snapshot.configurationReadOnly));
    const savedTo = snapshot.savedTo ? ` · ${snapshot.savedTo}` : '';
    const checkpoint = snapshot.lastRecovery ? ` · Last recovery ${new Date(snapshot.lastRecovery.createdAt).toLocaleString()}` : '';
    const issue = snapshot.recoveryError || snapshot.configurationError || (snapshot.configurationReadOnly ? 'Recovery settings are read-only; repair them explicitly to change automatic recovery.' : '');
    ui.$('protection-summary').textContent = `${snapshot.dirty ? 'Unsaved changes' : snapshot.savedTo ? 'Saved project' : 'New project; no saved file yet'}${savedTo}${checkpoint}${issue ? ` · ${issue}` : ''}`;
    ui.$('protection-enabled').checked = snapshot.enabled;
    ui.$('protection-interval').value = String(snapshot.intervalSeconds);
    ui.$('protection-retention').value = String(snapshot.retention);
    const settingsLocked = Boolean(snapshot.configurationReadOnly);
    for (const id of ['protection-enabled', 'protection-interval', 'protection-retention', 'protection-configure'])
      ui.$(id).disabled = settingsLocked;
    ui.$('protection-reset-config').hidden = !settingsLocked;
    if (snapshot.recoveryError || snapshot.configurationError)
      showError(snapshot.recoveryError || snapshot.configurationError);
    else if (!settingsLocked)
      showError('');
  }

  function receiveProjectProtection(incoming, authority = false, bridgeEpoch = null) {
    const value = incoming?.projectProtection ?? incoming;
    if (!value || typeof value !== 'object' || typeof value.epoch !== 'string' || !value.epoch || !Number.isSafeInteger(value.sequence) || typeof value.token !== 'string' || typeof value.dirty !== 'boolean') return false;
    if (ownerEpoch === null) {
      if (!authority || typeof bridgeEpoch !== 'string' || !bridgeEpoch) return false;
      ownerEpoch = bridgeEpoch;
      sequence = value.sequence;
    } else if (bridgeEpoch !== ownerEpoch) {
      if (!authority || typeof bridgeEpoch !== 'string' || !bridgeEpoch) return false;
      ownerEpoch = bridgeEpoch;
      sequence = value.sequence;
    } else {
      if (value.sequence <= sequence) return false;
      sequence = value.sequence;
    }
    snapshot = value;
    ui.projectProtection = value;
    renderSnapshot();
    if (authority && !startupChooserChecked) {
      startupChooserChecked = true;
      void refreshRecoveries({ startup: true });
    }
    return true;
  }

  async function refreshProtection(authority = false) {
    const result = await ui.command('project_protection_get');
    const next = commandSnapshot(result);
    const responseOwner = commandOwnerEpoch(result);
    if (!next || !responseOwner || (!authority && ownerEpoch !== responseOwner)) return null;
    receiveProjectProtection(next, authority, responseOwner);
    return snapshot;
  }

  function renderRecoveryList(selectId = ui.$('protection-recovery-list').value) {
    const select = ui.$('protection-recovery-list');
    select.replaceChildren(new Option('Choose a recovery version', ''), ...recoveries.map((item) => {
      const date = item.createdAt ? new Date(item.createdAt).toLocaleString() : 'Unknown date';
      return new Option(`${item.projectName || 'Untitled project'} · ${date} · ${item.mediaCount ?? 0} media`, item.id);
    }));
    if (recoveries.some((item) => item.id === selectId)) select.value = selectId;
    const selected = Boolean(select.value);
    for (const id of ['protection-inspect', 'protection-restore', 'protection-delete'])
      ui.$(id).disabled = !selected;
  }

  async function refreshRecoveries({ startup = false } = {}) {
    const request = ++recoveryRequest;
    const requestedOwner = ownerEpoch;
    const prior = ui.$('protection-recovery-list').value;
    const result = await ui.command('project_recovery_list');
    const responseOwner = commandOwnerEpoch(result);
    if (request !== recoveryRequest || !requestedOwner || ownerEpoch !== requestedOwner || responseOwner !== requestedOwner) return recoveries;
    const value = unwrap(result);
    if (!value) return [];
    recoveries = Array.isArray(value.recoveries) ? value.recoveries : [];
    if (value.projectProtection) receiveProjectProtection(value.projectProtection, false, responseOwner);
    renderRecoveryList(prior);
    if (startup && recoveries.length && !ui.$('project-protection-dialog').open) {
      renderRecoveryList(recoveries[0].id);
      ui.$('protection-inspection').textContent = 'Completed recovery versions are available. Inspect a version before restoring it.';
      ui.$('project-protection-dialog').showModal();
      void inspectSelected();
    }
    return recoveries;
  }

  function showInspection(value) {
    inspection = value;
    if (!value) {
      ui.$('protection-inspection').textContent = '';
      return;
    }
    const availability = (value.media ?? []).map((item) => `${item.assetId}: ${item.status}${item.reason ? ` (${item.reason})` : ''}`).join('\n');
    ui.$('protection-inspection').textContent = `${value.valid ? 'Recovery package validated' : 'Recovery package is not valid'}${availability ? `\n${availability}` : '\nNo media files'}`;
    ui.$('protection-restore').disabled = !value.valid;
  }

  function selectedRecoveryId() { return ui.$('protection-recovery-list').value; }

  async function inspectSelected() {
    const recoveryId = selectedRecoveryId();
    if (!recoveryId) return null;
    const request = ++inspectionRequest;
    const requestedOwner = ownerEpoch;
    const result = await ui.command('project_recovery_inspect', { recoveryId });
    const responseOwner = commandOwnerEpoch(result);
    if (request !== inspectionRequest || !requestedOwner || ownerEpoch !== requestedOwner || responseOwner !== requestedOwner || selectedRecoveryId() !== recoveryId) return null;
    const value = unwrap(result);
    if (!value) return null;
    if (value.projectProtection) receiveProjectProtection(value.projectProtection, false, responseOwner);
    showInspection(value);
    return value;
  }

  async function restoreSelected() {
    const recoveryId = selectedRecoveryId();
    if (!recoveryId) return false;
    if (!inspection || inspection.recovery?.id !== recoveryId) {
      await inspectSelected();
      if (!inspection?.valid) return false;
    }
    const approval = await ui.confirmProjectReplacement('restore this recovery version');
    if (!approval) return false;
    const result = await ui.command('project_recovery_restore', { recoveryId, expectedProtectionToken: approval.expectedProtectionToken, discardUnsaved: approval.discardUnsaved });
    const value = unwrap(result);
    if (!value) return false;
    if (value.projectProtection) receiveProjectProtection(value.projectProtection, false, commandOwnerEpoch(result));
    ui.toast('Recovery version restored. Save the recovered project to keep it as the normal project file.');
    await refreshRecoveries();
    return true;
  }

  async function deleteSelected() {
    const recoveryId = selectedRecoveryId();
    if (!recoveryId) return false;
    const result = await ui.command('project_recovery_delete', { recoveryId });
    const value = unwrap(result);
    if (!value) return false;
    if (value.projectProtection) receiveProjectProtection(value.projectProtection, false, commandOwnerEpoch(result));
    inspection = null;
    showInspection(null);
    await refreshRecoveries();
    ui.toast('Recovery version deleted');
    return true;
  }

  async function checkpoint() {
    const result = await ui.command('project_recovery_create');
    const value = unwrap(result);
    if (!value) return false;
    if (value.projectProtection) receiveProjectProtection(value.projectProtection, false, commandOwnerEpoch(result));
    await refreshRecoveries();
    ui.toast('Recovery version created');
    return true;
  }

  async function configure(patch, resetInvalid = false) {
    const result = await ui.command('project_protection_configure', { patch, ...(resetInvalid ? { resetInvalid: true } : {}) });
    const next = commandSnapshot(result);
    if (!next) return false;
    receiveProjectProtection(next, false, commandOwnerEpoch(result));
    ui.toast('Project protection settings updated');
    return true;
  }

  async function confirmProjectReplacement(action) {
    await refreshProtection(false);
    if (!snapshot) {
      ui.toast('Project protection is not ready; the current project was not replaced.', 'error');
      return null;
    }
    let expectedProtectionToken = snapshot.token;
    if (!snapshot.dirty) return { expectedProtectionToken, discardUnsaved: false };
    const dialog = ui.$('protection-replace-dialog');
    ui.$('protection-replace-message').textContent = `Save or discard unsaved changes before you ${action}?`;
    return new Promise((resolve) => {
      const finish = (decision) => {
        dialog.removeEventListener('cancel', cancel);
        dialog.close();
        resolve(decision);
      };
      const cancel = () => finish(null);
      const discard = () => {
        if (!snapshot || snapshot.token !== expectedProtectionToken) {
          expectedProtectionToken = snapshot?.token ?? '';
          ui.$('protection-replace-message').textContent = 'The project changed while this choice was open. Review the updated state, then choose again.';
          return;
        }
        finish({ expectedProtectionToken, discardUnsaved: true });
      };
      const save = async () => {
        const saveStart = snapshot?.token;
        const receipt = await ui.saveProject();
        if (!receipt?.saved) return;
        if (snapshot?.token === saveStart && !snapshot.dirty && receipt.savedToken === saveStart) {
          finish({ expectedProtectionToken: saveStart, discardUnsaved: false });
          return;
        }
        expectedProtectionToken = snapshot?.token ?? '';
        ui.$('protection-replace-message').textContent = 'The project changed during Save and remains unsaved. Review the current state and choose again.';
      };
      ui.$('protection-replace-cancel').onclick = cancel;
      ui.$('protection-replace-discard').onclick = discard;
      ui.$('protection-replace-save').onclick = () => { void save(); };
      dialog.addEventListener('cancel', cancel, { once: true });
      dialog.showModal();
    });
  }

  ui.$('btn-protection').addEventListener('click', async () => {
    ui.$('project-protection-dialog').showModal();
    await refreshProtection(false);
    await refreshRecoveries();
  });
  ui.$('protection-close').addEventListener('click', () => ui.$('project-protection-dialog').close());
  ui.$('protection-refresh').addEventListener('click', () => void refreshRecoveries());
  ui.$('protection-checkpoint').addEventListener('click', () => void checkpoint());
  ui.$('protection-configure').addEventListener('click', () => void configure({ enabled: ui.$('protection-enabled').checked, intervalSeconds: Number(ui.$('protection-interval').value), retention: Number(ui.$('protection-retention').value) }));
  ui.$('protection-reset-config').addEventListener('click', () => void configure({ enabled: true, intervalSeconds: 60, retention: 10 }, true));
  ui.$('protection-recovery-list').addEventListener('change', () => {
    inspectionRequest += 1;
    inspection = null;
    showInspection(null);
    const selected = Boolean(selectedRecoveryId());
    for (const id of ['protection-inspect', 'protection-restore', 'protection-delete']) ui.$(id).disabled = !selected;
  });
  ui.$('protection-inspect').addEventListener('click', () => void inspectSelected());
  ui.$('protection-restore').addEventListener('click', () => void restoreSelected());
  ui.$('protection-delete').addEventListener('click', () => void deleteSelected());

  Object.assign(ui, { receiveProjectProtection, refreshProtection, refreshRecoveries, checkpointRecovery: checkpoint, confirmProjectReplacement });
}
