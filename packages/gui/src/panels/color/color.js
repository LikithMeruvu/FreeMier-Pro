
export function registerColorControls(ui) {
  function renderColorControls(panel, clip, track) {
    if (ui.workspace === 'color' && track.kind === 'video')
      panel.append(ui.button('＋ Color adjustment', 'Add a real RGB color adjustment', () => ui.addSelectedEffect('color_adjust'), 'accent'));
  }
  ui.renderColorControls = renderColorControls;
}
