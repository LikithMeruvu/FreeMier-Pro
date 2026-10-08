
export function bindMarkersEvents(ui) {
  ui.$('btn-marker').addEventListener('click', ui.addAtHead);
  ui.$('marker-create').addEventListener('click', ui.addAtHead);
  ui.$('marker-prev').addEventListener('click', () => ui.navigateMarker(-1));
  ui.$('marker-next').addEventListener('click', () => ui.navigateMarker(1));
}
