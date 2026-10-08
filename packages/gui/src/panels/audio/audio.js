
export function registerPanelsAudioAudio(ui) {
  // Actual media decoders + Web Audio gain, with one decoder per clip.
  function audioBus(el) {
    ui.audioContext ??= new AudioContext();
    const source = ui.audioContext.createMediaElementSource(el), gain = ui.audioContext.createGain(), analyser = ui.audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(ui.audioContext.destination);
    return { source, gain, analyser };
  }
  Object.assign(ui, { audioBus });
}

export function registerAudioControls(ui) {
  function renderAudioControls(panel, clip, track) {
    ui.heading('Gain');
    if (track.kind === 'audio') {
      ui.numericControl(panel, 'Volume', clip.volume, 0, 4, .01, (volume) => ui.command('clip_set_audio', { clipId: clip.id, volume }));
      const meter = ui.node('div', 'meter'), fill = ui.node('div', 'meter-fill');
      fill.id = 'audio-meter-fill';
      meter.append(fill);
      const label = ui.node('div', 'meter-label', 'RMS −∞ dBFS · decoded output');
      label.id = 'audio-meter-label';
      panel.append(meter, label);
    }
    else
      panel.append(ui.node('div', 'inspector-note', 'Audio is mixed from audio tracks. Place the source on an audio track to hear or edit its gain.'));
  }
  ui.renderAudioControls = renderAudioControls;
}
