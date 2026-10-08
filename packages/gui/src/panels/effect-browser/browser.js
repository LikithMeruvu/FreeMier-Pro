import { EFFECT_CATALOG } from '@freemier/shared/effects';

export function registerEffectBrowser(ui) {
  function renderEffectBrowser(query) {
    ui.$('effects-browser').replaceChildren();
    for (const kind of ['video', 'audio']) {
      const matches = EFFECT_CATALOG.filter((e) => e.media === kind && e.name.toLowerCase().includes(query));
      if (!matches.length)
        continue;
      ui.$('effects-browser').append(ui.node('div', 'effect-category', kind + ' effects'));
      for (const effect of matches) {
        const tile = ui.button('', 'Add ' + effect.name + ' to the selected matching clip', () => ui.addSelectedEffect(effect.type), 'effect-tile');
        tile.dataset.effectType = effect.type;
        const label = ui.node('div', '', effect.name);
        label.append(ui.node('small', '', effect.preview === 'envelope' ? 'Clip-local envelope' : effect.type === 'blur' || effect.type === 'sharpen' ? 'CPU · spatial preview approximation' : 'CPU · shared RGB processing'));
        tile.append(ui.node('span', 'effect-icon', 'fx'), label);
        ui.$('effects-browser').append(tile);
      }
    }
  }
  ui.renderEffectBrowser = renderEffectBrowser;
}
