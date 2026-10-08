
export function bindTitlesEvents(ui) {
  ui.$('title-create').addEventListener('click', () => ui.command('title_add', { text: ui.$('title-text').value || 'New title', start: ui.playhead, end: ui.q(ui.playhead + 3), style: { fontSize: Math.max(8, Math.round(ui.project.timeline.height / 12)) } }));
}
