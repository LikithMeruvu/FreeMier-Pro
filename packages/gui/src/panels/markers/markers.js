
export function registerPanelsMarkersMarkers(ui) {
  function renderMarkers(query = '') {
    const list = ui.$('marker-list');
    list.replaceChildren();
    for (const marker of (ui.project?.timeline.markers ?? []).filter((m) => (m.label + ' ' + m.notes).toLowerCase().includes(query))) {
      const row = ui.node('div', 'marker-card');
      row.dataset.markerId = marker.id;
      row.style.borderLeftColor = marker.color;
      const title = ui.node('div', 'marker-card-head'), jump = ui.button(ui.tc(marker.time), 'Seek marker ' + marker.label, () => ui.setHead(marker.time));
      jump.dataset.markerJump = marker.id;
      const remove = ui.button('×', 'Delete marker ' + marker.label, () => ui.command('marker_remove', { markerId: marker.id }));
      remove.dataset.markerRemove = marker.id;
      title.append(jump, remove);
      const label = ui.node('input');
      label.value = marker.label;
      label.maxLength = 120;
      label.setAttribute('aria-label', 'Marker label ' + marker.id);
      label.addEventListener('change', () => ui.command('marker_update', { markerId: marker.id, label: label.value }));
      const color = ui.node('input');
      color.type = 'color';
      color.value = marker.color;
      color.setAttribute('aria-label', 'Marker color ' + marker.id);
      color.addEventListener('change', () => ui.command('marker_update', { markerId: marker.id, color: color.value }));
      const notes = ui.node('textarea');
      notes.rows = 2;
      notes.maxLength = 4096;
      notes.value = marker.notes;
      notes.placeholder = 'Notes';
      notes.setAttribute('aria-label', 'Marker notes ' + marker.id);
      notes.addEventListener('change', () => ui.command('marker_update', { markerId: marker.id, notes: notes.value }));
      row.append(title, label, color);
      ui.numericControl(row, 'Time (seconds)', marker.time, 0, 86400, 1 / ui.fps(), (time) => ui.command('marker_update', { markerId: marker.id, time }));
      row.append(notes);
      list.append(row);
    }
    if (!list.children.length)
      list.append(ui.node('div', 'empty', 'Add a marker at the playhead. M adds a point; the arrow controls navigate points.'));
  }

  async function addAtHead() { await ui.command('marker_add', { time: ui.playhead, label: ui.$('marker-label').value.trim() || 'Marker ' + ui.tc(ui.playhead) }); }

  function navigateMarker(direction) {
    const ordered = [...(ui.project?.timeline.markers ?? [])].sort((a, b) => a.time - b.time);
    const marker = direction > 0 ? ordered.find((m) => m.time > ui.playhead + 1e-6) : ordered.filter((m) => m.time < ui.playhead - 1e-6).at(-1);
    if (marker)
      ui.setHead(marker.time);
  }
  Object.assign(ui, { renderMarkers, addAtHead, navigateMarker });
}
