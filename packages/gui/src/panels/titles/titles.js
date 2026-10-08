
export function registerPanelsTitlesTitles(ui) {
  function renderTitles(query = '') {
    const list = ui.$('title-list');
    list.replaceChildren();
    for (const title of (ui.project?.timeline.titles ?? []).filter((t) => t.text.toLowerCase().includes(query))) {
      const card = ui.node('div', 'text-card');
      card.dataset.titleId = title.id;
      const top = ui.node('div', 'marker-card-head');
      top.append(ui.button(ui.tc(title.start), 'Seek title', () => ui.setHead(title.start)), ui.button('×', 'Delete title', () => ui.command('title_remove', { titleId: title.id })));
      card.append(top);
      const text = ui.node('textarea');
      text.rows = 2;
      text.maxLength = 4096;
      text.value = title.text;
      text.setAttribute('aria-label', 'Title text');
      text.addEventListener('change', () => ui.command('title_update', { titleId: title.id, text: text.value }));
      card.append(text);
      for (const field of ['start', 'end'])
        ui.numericControl(card, 'Title ' + field, title[field], 0, 86400, 1 / ui.fps(), (value) => ui.command('title_update', { titleId: title.id, [field]: value }));
      ui.textStyleControls(card, title.style, (style) => ui.command('title_update', { titleId: title.id, style }));
      list.append(card);
    }
  }
  Object.assign(ui, { renderTitles });
}
