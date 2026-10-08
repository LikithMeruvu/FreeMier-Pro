import { describeEffectPreset } from '@freemier/shared/presets';

export function registerPanelsPresetsPresets(ui) {
  function filteredPresets(query = '') {
    return (ui.project?.effectPresets ?? []).filter(({ document: p }) => [p.name, p.description, p.author, ...p.tags].join(' ').toLowerCase().includes(query));
  }

  function renderPresets(query = '') {
    const list = ui.$('preset-list');
    list.replaceChildren();
    ui.$('preset-capture').disabled = !ui.find()?.clip.effects.length;
    for (const preset of ui.filteredPresets(query)) {
      const p = preset.document, info = describeEffectPreset(p), card = ui.node('div', 'text-card preset-card');
      card.dataset.presetId = preset.id;
      card.append(ui.node('strong', '', p.name), ui.node('p', 'preset-description', p.description || 'No author description supplied'), ui.node('small', '', [p.media.toUpperCase(), p.author, ...p.tags].filter(Boolean).join(' · ')));
      const details = ui.node('details');
      details.append(ui.node('summary', '', 'Effects, controls and compatibility'));
      details.append(ui.node('pre', '', JSON.stringify({ sha256: preset.sha256, descriptionSource: info.descriptionSource, effects: info.effects, compatibility: info.compatibility }, null, 2)));
      card.append(details);
      const row = ui.node('div', 'button-row');
      for (const mode of ['append', 'replace']) {
        const apply = ui.button(mode === 'append' ? 'Append' : 'Replace', mode + ' this preset on the selected clip', () => ui.command('effect_preset_apply', { presetId: preset.id, clipId: ui.selectedClipId, mode }));
        apply.dataset.presetApply = mode;
        const selected = ui.find();
        apply.disabled = !selected || selected.track.locked || selected.track.kind !== p.media;
        row.append(apply);
      }
      row.append(ui.button('JSON', 'Show portable JSON', async () => {
        const result = await ui.command('effect_preset_export', { presetId: preset.id }); if (result)
          ui.$('preset-json').value = result.content;
      }));
      row.append(ui.button('Save file', 'Create a new .fmfx.json file', async () => {
        const path = await ui.api.pickPresetSavePath(); if (path && await ui.command('effect_preset_export', { presetId: preset.id, path }))
          ui.toast('Preset file saved');
      }));
      row.append(ui.button('×', 'Remove imported preset; applied effects remain', () => ui.command('effect_preset_remove', { presetId: preset.id })));
      card.append(row);
      list.append(card);
    }
    if (!list.children.length)
      list.append(ui.node('div', 'empty', 'Import a portable effect preset, or capture a selected clip stack.'));
  }
  Object.assign(ui, { filteredPresets, renderPresets });
}
