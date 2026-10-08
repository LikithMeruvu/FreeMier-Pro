
export function bindCaptionsEvents(ui) {
  ui.$('caption-create').addEventListener('click', () => { const startMs = Math.round(ui.playhead * 1000); return ui.command('caption_add', { text: ui.$('caption-text').value || 'New caption', startMs, endMs: startMs + 2000 }); });
  ui.$('caption-lock').addEventListener('click', () => ui.command('caption_track_update', { locked: !ui.project.timeline.captions?.locked }));
  ui.$('caption-name').addEventListener('change', () => ui.command('caption_track_update', { name: ui.$('caption-name').value }));
  ui.$('caption-enabled').addEventListener('change', () => ui.command('caption_track_update', { enabled: ui.$('caption-enabled').checked }));
  ui.$('caption-import').addEventListener('click', () => ui.command('captions_import', { content: ui.$('caption-srt').value, mode: 'replace' }));
  ui.$('caption-export').addEventListener('click', async () => {
    const result = await ui.command('captions_export'); if (result)
      ui.$('caption-srt').value = result.content;
  });
}
