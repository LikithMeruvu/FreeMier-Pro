/** Transition controls are a view over the owning service project snapshot. */
export function registerPanelsTransitionsTransitions(ui) {
  const tracks = () => ui.project?.timeline.tracks ?? [];
  const clips = () => tracks().flatMap((track) => track.clips.map((clip) => ({ track, clip })));
  const transitions = () => ui.project?.timeline.transitions ?? [];
  const label = (clipId) => {
    const found = clips().find(({ clip }) => clip.id === clipId);
    return found ? `${found.track.name}: ${found.clip.label ?? ui.assetFor(found.clip)?.name ?? found.clip.id}` : clipId;
  };
  function selectTransition(transition) {
    ui.selectedTransitionId = transition.id;
    ui.$('transition-frames').value = transition.durationFrames;
    ui.$('transition-type').value = transition.type;
    ui.$('transition-alignment').value = transition.alignment ?? 'center';
  }

  function renderTransitionsPanel() {
    if (!ui.project) return;
    const left = ui.$('transition-left'), right = ui.$('transition-right');
    const priorLeft = left.value, priorRight = right.value;
    const candidates = clips().filter(({ track }) => track.kind === 'video' || track.kind === 'audio');
    const option = ({ clip }) => {
      const item = ui.node('option', '', label(clip.id)); item.value = clip.id; return item;
    };
    left.replaceChildren(...candidates.map(option)); right.replaceChildren(...candidates.map(option));
    if (candidates.some(({ clip }) => clip.id === priorLeft)) left.value = priorLeft;
    if (candidates.some(({ clip }) => clip.id === priorRight)) right.value = priorRight;

    const list = ui.$('transition-list'), selected = ui.selectedTransitionId;
    list.replaceChildren();
    for (const transition of transitions()) {
      const card = ui.node('div', 'transition-card' + (selected === transition.id ? ' selected' : ''));
      card.dataset.transitionId = transition.id;
      const choose = ui.button(`${label(transition.leftClipId)} → ${label(transition.rightClipId)}`, 'Select transition', () => {
        selectTransition(transition);
        renderTransitionsPanel();
      }, 'transition-select');
      const meta = ui.node('span', 'transition-meta', `${transition.type.replace('_', ' ')} · ${transition.durationFrames} frames · ${transition.alignment ?? 'center'}`);
      const remove = ui.button('×', 'Remove transition', () => void ui.command('transition_remove', { transitionId: transition.id, expectedRevision: ui.revision }), 'transition-remove');
      card.append(choose, meta, remove); list.append(card);
    }
    ui.$('transition-update').disabled = !transitions().some((item) => item.id === selected);
    ui.$('transition-remove').disabled = !transitions().some((item) => item.id === selected);
    ui.$('transition-list').dataset.count = String(transitions().length);
  }

  ui.$('transition-add').addEventListener('click', async () => {
    const result = await ui.command('transition_add', {
      leftClipId: ui.$('transition-left').value,
      rightClipId: ui.$('transition-right').value,
      type: ui.$('transition-type').value,
      durationFrames: Number(ui.$('transition-frames').value),
      alignment: ui.$('transition-alignment').value,
      expectedRevision: ui.revision,
    });
    if (result?.transition) { ui.selectedTransitionId = result.transition.id; renderTransitionsPanel(); }
  });
  ui.$('transition-update').addEventListener('click', () => {
    if (ui.selectedTransitionId) void ui.command('transition_update', {
      transitionId: ui.selectedTransitionId,
      durationFrames: Number(ui.$('transition-frames').value),
      alignment: ui.$('transition-alignment').value,
      expectedRevision: ui.revision,
    });
  });
  ui.$('transition-remove').addEventListener('click', () => {
    if (ui.selectedTransitionId) void ui.command('transition_remove', { transitionId: ui.selectedTransitionId, expectedRevision: ui.revision });
  });
  Object.assign(ui, { renderTransitions: renderTransitionsPanel, renderTransitionsPanel, selectTransition });
}
