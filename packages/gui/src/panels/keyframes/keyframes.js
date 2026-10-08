import { EASINGS, evaluateAnimatable, evaluateTransform } from '@freemier/shared/animation';

export function registerPanelsKeyframesKeyframes(ui) {
  function drawCurve(plot, curve, length, time) {
    const c = plot.getContext('2d'), values = [curve.value, ...curve.keyframes.map((k) => k.value)], min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
    const x = (t) => t / length * 250 + 5, y = (v) => 54 - (v - min) / range * 44;
    c.strokeStyle = '#353b49';
    for (let i = 1; i < 4; i++) {
      c.beginPath();
      c.moveTo(0, i * 16);
      c.lineTo(260, i * 16);
      c.stroke();
    }
    c.strokeStyle = '#b19bec';
    c.beginPath();
    for (let i = 0; i <= 250; i++) {
      const v = evaluateAnimatable(curve, i / 250 * length);
      if (i)
        c.lineTo(i + 5, y(v));
      else
        c.moveTo(5, y(v));
    }
    c.stroke();
    c.fillStyle = '#d2bfff';
    for (const key of curve.keyframes) {
      c.beginPath();
      c.arc(x(key.time), y(key.value), 3, 0, Math.PI * 2);
      c.fill();
    }
    c.strokeStyle = '#f0a35e';
    c.beginPath();
    c.moveTo(x(time), 0);
    c.lineTo(x(time), 64);
    c.stroke();
  }
  Object.assign(ui, { drawCurve });
}

export function registerKeyframeControls(ui) {
  function renderKeyframeControls(panel, clip, time) {
    ui.heading('Motion · local ' + ui.tc(time));
    const transform = evaluateTransform(clip.transform, time);
    const specs = [['Scale', 'scale', .01, 10, .01], ['Position X', 'x', -10, 10, .01], ['Position Y', 'y', -10, 10, .01], ['Rotation', 'rotation', -36000, 36000, 1], ['Opacity', 'opacity', 0, 1, .01]];
    for (const [label, property, min, max, step] of specs) {
      const curve = clip.transform[property], existing = curve.keyframes.find((k) => Math.abs(k.time - ui.q(time)) < 1e-6);
      const key = ui.button('◆', existing ? 'Remove keyframe at playhead' : 'Add keyframe at playhead', () => ui.command(existing ? 'keyframe_remove' : 'keyframe_set', { clipId: clip.id, property, time: ui.q(time), ...(existing ? {} : { value: transform[property] }) }), 'key-button' + (curve.keyframes.length ? ' keyed' : ''));
      key.dataset.keyProperty = property;
      ui.numericControl(panel, label, transform[property], min, max, step, (value) => ui.command(curve.keyframes.length ? 'keyframe_set' : 'clip_set_transform', { clipId: clip.id, ...(curve.keyframes.length ? { property, time: ui.q(time), value } : { [property]: value }) }), key);
    }
    const section = ui.heading('Keyframes');
    const choice = ui.node('select');
    choice.setAttribute('aria-label', 'Keyframe property');
    for (const property of ['x', 'y', 'scale', 'rotation', 'opacity']) {
      const opt = ui.node('option', '', property);
      opt.value = property;
      choice.append(opt);
    }
    choice.value = ui.renderInspector.keyProperty ?? 'opacity';
    section.append(choice);
    choice.addEventListener('change', () => { ui.renderInspector.keyProperty = choice.value; ui.renderInspector(); });
    const property = choice.value, curve = clip.transform[property], plot = ui.node('canvas', 'curve');
    plot.width = 260;
    plot.height = 64;
    plot.dataset.property = property;
    panel.append(plot);
    ui.drawCurve(plot, curve, clip.duration, time);
    const list = ui.node('div', 'key-list');
    for (const key of curve.keyframes) {
      const row = ui.node('div', 'key-row'), value = ui.node('input'), easing = ui.node('select');
      value.type = 'number';
      value.value = key.value;
      value.setAttribute('aria-label', 'Keyframe value at ' + key.time);
      for (const e of EASINGS) {
        const opt = ui.node('option', '', e);
        opt.value = e;
        easing.append(opt);
      }
      easing.value = key.easing;
      easing.setAttribute('aria-label', 'Keyframe easing at ' + key.time);
      const update = () => ui.command('keyframe_set', { clipId: clip.id, property, time: key.time, value: Number(value.value), easing: easing.value });
      value.addEventListener('change', update);
      easing.addEventListener('change', update);
      row.append(ui.button(ui.tc(key.time), 'Seek keyframe', () => ui.setHead(clip.start + key.time)), value, easing, ui.button('×', 'Remove keyframe', () => ui.command('keyframe_remove', { clipId: clip.id, property, time: key.time })));
      list.append(row);
    }
    panel.append(list);
  }
  ui.renderKeyframeControls = renderKeyframeControls;
}
