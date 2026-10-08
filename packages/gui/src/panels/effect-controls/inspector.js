import { EFFECT_CATALOG } from '@freemier/shared/effects';

export function registerPanelsEffectControlsInspector(ui) {
  async function addSelectedEffect(type) {
    const sel = ui.find();
    if (!sel) {
      ui.toast('Select a clip to add an effect', 'error');
      return;
    }
    const descriptor = EFFECT_CATALOG.find((e) => e.type === type), params = {};
    if (type.endsWith('_fade'))
      params.duration = Math.min(1, sel.clip.duration);
    if (descriptor?.media !== sel.track.kind) {
      ui.toast('Select a ' + descriptor?.media + ' clip on a ' + descriptor?.media + ' track', 'error');
      return;
    }
    await ui.command('effect_add', { clipId: sel.clip.id, type, params });
  }

  function renderInspector() {
    const panel = ui.$('inspector');
    panel.replaceChildren();
    const sel = ui.find();
    ui.$('inspector-title').textContent = ui.workspace === 'color' ? 'Color controls' : ui.workspace === 'audio' ? 'Audio mix' : 'Effect controls';
    ui.$('selection-kind').textContent = sel?.track.kind.toUpperCase() ?? 'SEQUENCE';
    ui.$('selection-info').textContent = sel ? (sel.clip.label ?? ui.assetFor(sel.clip)?.name ?? 'Clip') + ' · ' + ui.tc(sel.clip.duration) : 'No clip selected';
    if (!sel) {
      panel.append(ui.node('div', 'empty', 'Select a timeline clip. Every control edits the same project as your MCP client.'));
      return;
    }
    const { clip, track } = sel, time = ui.local(clip);
    panel.append(ui.node('div', 'selection-heading', clip.label ?? ui.assetFor(clip)?.name ?? 'Clip'), ui.node('div', 'clip-summary', track.name + ' · ' + ui.tc(clip.start) + ' → ' + ui.tc(clip.start + clip.duration) + '\nSource ' + ui.tc(clip.sourceIn) + ' → ' + ui.tc(clip.sourceOut)));
    if (track.locked)
      panel.append(ui.node('div', 'inspector-note', 'Track is locked. Unlock its header to edit content.'));
    if (ui.workspace === 'edit' && track.kind === 'video') ui.renderKeyframeControls(panel, clip, time);
    if (ui.workspace === 'audio' || track.kind === 'audio') ui.renderAudioControls(panel, clip, track);
    ui.heading(ui.workspace === 'color' ? 'Color stack' : 'Effects stack');
    ui.renderColorControls(panel, clip, track);
    const effects = clip.effects.filter((effect) => ui.workspace === 'color' ? ['color_adjust', 'grayscale', 'sepia'].includes(effect.type) : ui.workspace === 'audio' ? effect.type === 'audio_fade' : true);
    for (const effect of effects) {
      const descriptor = EFFECT_CATALOG.find((e) => e.type === effect.type), card = ui.node('div', 'effect-card');
      card.dataset.effectId = effect.id;
      card.dataset.effectType = effect.type;
      const head = ui.node('header'), toggle = ui.node('input');
      toggle.type = 'checkbox';
      toggle.checked = effect.enabled;
      toggle.setAttribute('aria-label', 'Enable ' + effect.type);
      toggle.addEventListener('change', () => ui.command('effect_update', { clipId: clip.id, effectId: effect.id, enabled: toggle.checked }));
      head.append(toggle, ui.node('span', '', descriptor?.name ?? effect.type), ui.button('×', 'Remove effect', () => ui.command('effect_remove', { clipId: clip.id, effectId: effect.id })));
      card.append(head);
      for (const [name, schema] of Object.entries(descriptor?.params ?? {})) {
        if (schema.type === 'number')
          ui.numericControl(card, name, Number(effect.params[name] ?? schema.default), schema.min, schema.max, .01, (value) => ui.command('effect_update', { clipId: clip.id, effectId: effect.id, params: { [name]: value } }));
        else {
          const row = ui.node('div', 'control-row'), select = ui.node('select');
          for (const value of schema.choices) {
            const opt = ui.node('option', '', value);
            opt.value = value;
            select.append(opt);
          }
          select.value = effect.params[name] ?? schema.default;
          select.setAttribute('aria-label', name);
          select.addEventListener('change', () => ui.command('effect_update', { clipId: clip.id, effectId: effect.id, params: { [name]: select.value } }));
          row.append(ui.node('label', '', name), select);
          card.append(row);
        }
      }
      if (effect.type === 'blur' || effect.type === 'sharpen')
        card.append(ui.node('div', 'inspector-note', 'Live spatial kernel is an approximation. Export uses FFmpeg.'));
      if (!descriptor)
        card.append(ui.node('div', 'inspector-note', 'Unsupported effect. Remove or disable before export.'));
      panel.append(card);
    }
    if (!effects.length)
      panel.append(ui.node('div', 'inspector-note', 'Choose an effect from the Effects browser.'));
    if (Object.values(clip.transform).some((p) => p.keyframes.length) || clip.effects.some((e) => e.enabled && e.type.endsWith('_fade')))
      panel.append(ui.node('div', 'inspector-note', 'Animated/fading clips: split and head trim cannot rebase curves yet. Moving/slipping/duplicating preserves local animation; unsupported boundary edits return an error.'));
  }
  Object.assign(ui, { addSelectedEffect, renderInspector });
}
