
export function registerWorkspaceProjects(ui) {
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
  Object.assign(ui, { saveProject, openProject });
}
