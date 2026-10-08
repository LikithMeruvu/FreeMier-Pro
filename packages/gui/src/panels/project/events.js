
export function bindProjectEvents(ui) {
  ui.$('btn-import').addEventListener('click', async () => {
    const paths = await ui.api.pickMedia(); for (const path of paths ?? []) {
      const result = await ui.command('media_import', { path });
      if (result)
        ui.toast('Imported ' + result.asset.name);
    }
  });
  ui.$('bin-search').addEventListener('input', ui.renderMediaBin);
  ui.$('bin-view').addEventListener('click', () => { ui.grid = !ui.grid; ui.$('bin-view').textContent = ui.grid ? '▦' : '☷'; ui.renderMediaBin(); });
  for (const button of document.querySelectorAll('[data-browser]'))
    button.addEventListener('click', () => { ui.browser = button.dataset.browser; ui.$('bin-search').value = ''; document.querySelectorAll('[data-browser]').forEach((b) => b.classList.toggle('active', b === button)); ui.renderMediaBin(); });
}
