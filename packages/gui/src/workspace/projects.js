
export function registerWorkspaceProjects(ui) {
  ui.projectDialogMode = 'create';
  ui.$('project-form').addEventListener('submit', async (event) => {
    if (event.submitter?.value !== 'submit') return;
    event.preventDefault();
    if (!ui.$('project-form').reportValidity()) return;
    ui.$('project-dialog').close();
    const args = { name: ui.$('project-form-name').value.trim(), width: Number(ui.$('project-form-width').value), height: Number(ui.$('project-form-height').value), fps: Number(ui.$('project-form-fps').value) };
    const mode = ui.projectDialogMode;
    const result = mode === 'create'
      ? await ui.command('project_create', { ...args, name: args.name || 'Untitled Project' })
      : await ui.command('project_update', { ...args, name: args.name || ui.project?.name });
    if (result) ui.toast(mode === 'create' ? 'New project created' : 'Project settings updated');
  });
  async function createProject() {
    const authored = ui.project && (ui.project.media.length > 0 || ui.project.timeline.tracks.some((track) => track.clips.length) || ui.project.timeline.titles?.length || ui.project.timeline.captions?.cues.length || ui.project.timeline.markers?.length);
    if (authored && !window.confirm('Create a new project? This will discard the current project and its authored work.')) return;
    const dialog = ui.$('project-dialog');
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
    const path = await ui.api.pickProjectSavePath(); if (!path)
      return; if (await ui.command('project_save', { path }))
      ui.toast('Project saved');
  }

  async function openProject() {
    const path = await ui.api.pickProjectOpenPath(); if (!path)
      return; ui.playing = ui.sourcePlaying = false; if (await ui.command('project_load', { path }))
      ui.toast('Project opened');
  }
  ui.$('btn-new-project').addEventListener('click', createProject);
  ui.$('btn-project-settings').addEventListener('click', editProjectSettings);
  ui.$('project-form-cancel').addEventListener('click', () => ui.$('project-dialog').close());
  Object.assign(ui, { saveProject, openProject, createProject, editProjectSettings });
}
