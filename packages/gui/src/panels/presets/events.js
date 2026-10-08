
export function bindPresetsEvents(ui) {
  ui.$('preset-import-file').addEventListener('click', async () => {
    const path = await ui.api.pickPreset(); if (path)
      await ui.command('effect_preset_import', { path });
  });
  ui.$('preset-import-json').addEventListener('click', () => ui.command('effect_preset_import', { content: ui.$('preset-json').value }));
  ui.$('preset-inspect').addEventListener('click', async () => {
    const result = await ui.command('effect_preset_inspect', { content: ui.$('preset-json').value }); if (result)
      ui.$('preset-inspection').textContent = JSON.stringify(result.preset, null, 2);
  });
  ui.$('preset-capture').addEventListener('click', async () => {
    const result = await ui.command('effect_preset_capture', { clipId: ui.selectedClipId, name: ui.$('preset-name').value || 'Captured stack', description: ui.$('preset-description').value }); if (result)
      ui.$('preset-json').value = result.content;
  });
}
