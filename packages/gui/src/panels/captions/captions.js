import { captionFrames } from '@freemier/shared/captions';

export function registerPanelsCaptionsCaptions(ui) {
  function renderCaptions(query = '') {
    const track = ui.project?.timeline.captions, list = ui.$('caption-list');
    list.replaceChildren();
    ui.$('caption-track-state').textContent = track ? `${track.name} · ${track.enabled ? 'enabled' : 'disabled'} · ${track.locked ? 'locked' : 'unlocked'}` : 'No track';
    ui.$('caption-lock').textContent = track?.locked ? 'Unlock' : 'Lock';
    ui.$('caption-name').value = track?.name ?? 'Captions';
    ui.$('caption-enabled').checked = track?.enabled ?? true;
    for (const id of ['caption-name', 'caption-enabled', 'caption-create', 'caption-import'])
      ui.$(id).disabled = track?.locked ?? false;
    if (!track) {
      list.append(ui.node('div', 'empty', 'Add a cue or import SRT to create a subtitle track.'));
      return;
    }
    for (const cue of track.cues.filter((item) => item.text.toLowerCase().includes(query))) {
      const card = ui.node('div', 'text-card caption-card');
      card.dataset.cueId = cue.id;
      const coverage = captionFrames(cue, ui.fps());
      const top = ui.node('div', 'marker-card-head');
      top.append(ui.button(ui.tc(coverage.startFrame / ui.fps()), 'Seek caption', () => coverage.hasFrame ? ui.setHead(coverage.startFrame / ui.fps()) : ui.toast('No sequence frame lies inside this cue', 'error')), ui.button('×', 'Delete caption', () => ui.command('caption_remove', { cueId: cue.id })));
      card.append(top);
      const input = ui.node('textarea');
      input.rows = 2;
      input.value = cue.text;
      input.maxLength = 4096;
      input.setAttribute('aria-label', 'Caption text');
      input.addEventListener('change', () => ui.command('caption_update', { cueId: cue.id, text: input.value }));
      card.append(input);
      for (const field of ['startMs', 'endMs'])
        ui.numericControl(card, field === 'startMs' ? 'Start ms' : 'End ms', cue[field], 0, 86400000, 1, (value) => ui.command('caption_update', { cueId: cue.id, [field]: Math.round(value) }));
      list.append(card);
    }
    ui.textStyleControls(list, track.style, (style) => ui.command('caption_track_update', { style }));
    if (track.locked)
      list.querySelectorAll('button,textarea,input,select').forEach((el) => { el.disabled = true; });
  }
  Object.assign(ui, { renderCaptions });
}
