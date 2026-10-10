
export function registerWorkspaceProjects(ui) {
  ui.projectDialogMode = 'create';
  ui.projectReplaceApproval = null;
  ui.$('project-form').addEventListener('submit', async (event) => {
    if (event.submitter?.value !== 'submit') return;
    event.preventDefault();
    if (!ui.$('project-form').reportValidity()) return;
    const args = { name: ui.$('project-form-name').value.trim(), width: Number(ui.$('project-form-width').value), height: Number(ui.$('project-form-height').value), fps: Number(ui.$('project-form-fps').value) };
    const mode = ui.projectDialogMode;
    const result = mode === 'create'
      ? await ui.command('project_replace', { action: 'create', ...args, name: args.name || 'Untitled Project', ...(ui.projectReplaceApproval ?? {}) })
      : await ui.command('project_update', { ...args, name: args.name || ui.project?.name });
    if (!result) return;
    ui.projectReplaceApproval = null;
    ui.$('project-dialog').close();
    if (result) ui.toast(mode === 'create' ? 'New project created' : 'Project settings updated');
  });
  async function createProject() {
    const approval = await ui.confirmProjectReplacement('create a new project');
    if (!approval) return;
    const dialog = ui.$('project-dialog');
    ui.projectReplaceApproval = approval;
    ui.projectDialogMode = 'create';
    ui.$('project-dialog-title').textContent = 'New Project';
    ui.$('project-form-submit').textContent = 'Create Project';
    ui.$('project-form-name').value = 'Untitled Project';
    ui.$('project-form-width').value = String(ui.project?.timeline.width ?? 1920);
    ui.$('project-form-height').value = String(ui.project?.timeline.height ?? 1080);
    ui.$('project-form-fps').value = String(ui.project?.timeline.fps ?? 30);
    dialog.showModal();
  }

  async function editProjectSettings() {
    const p = ui.project;
    if (!p) return;
    const dialog = ui.$('project-dialog');
    ui.projectDialogMode = 'settings';
    ui.$('project-dialog-title').textContent = 'Project Settings';
    ui.$('project-form-submit').textContent = 'Save Settings';
    ui.$('project-form-name').value = p.name;
    ui.$('project-form-width').value = String(p.timeline.width);
    ui.$('project-form-height').value = String(p.timeline.height);
    ui.$('project-form-fps').value = String(p.timeline.fps);
    dialog.showModal();
  }
  async function saveProject() {
    const savedTo = ui.projectProtection?.savedTo?.replace(/[\\/]project\.json$/i, '');
    const path = savedTo || await ui.api.pickProjectSavePath();
    if (!path) return { saved: false, savedToken: null };
    const result = await ui.command('project_save', { path });
    if (!result) return { saved: false, savedToken: null };
    const value = result.data ?? result;
    const savedToken = value.savedToken ?? result.savedToken;
    if (!savedToken) {
      ui.toast('Save returned no protection receipt', 'error');
      return { saved: false, savedToken: null };
    }
    if (ui.projectProtection?.dirty) ui.toast('Saved the captured snapshot; newer edits remain unsaved');
    else ui.toast('Project saved');
    return { saved: true, savedToken, savedTo: value.savedTo ?? result.savedTo };
  }

  async function openProject() {
    const approval = await ui.confirmProjectReplacement('open another project');
    if (!approval) return;
    const path = await ui.api.pickProjectOpenPath();
    if (!path) return;
    const result = await ui.command('project_replace', { action: 'load', path, ...approval });
    if (result) {
      ui.playing = ui.sourcePlaying = false;
      ui.toast('Project opened');
    }
  }
  ui.$('btn-new-project').addEventListener('click', createProject);
  ui.$('btn-project-settings').addEventListener('click', editProjectSettings);
  ui.$('project-form-cancel').addEventListener('click', () => { ui.projectReplaceApproval = null; ui.$('project-dialog').close(); });
  Object.assign(ui, { saveProject, openProject, createProject, editProjectSettings });
}
