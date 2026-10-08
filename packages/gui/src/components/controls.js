import { frameTimecode } from '@freemier/shared/timecode';

export function registerComponentsControls(ui) {
  function tc(seconds, rate = ui.fps()) {
    return frameTimecode(seconds, rate);
  }

  function toast(message, kind = '') { ui.$('toast').textContent = message; ui.$('toast').className = 'toast show ' + kind; clearTimeout(ui.toast.timer); ui.toast.timer = setTimeout(() => ui.$('toast').className = 'toast', 3200); }

  function node(tag, cls, text) {
    const el = document.createElement(tag); if (cls)
      el.className = cls; if (text !== undefined)
      el.textContent = text; return el;
  }

  function button(text, title, onClick, cls = '') { const el = ui.node('button', cls, text); el.title = title; el.addEventListener('click', onClick); return el; }

  // Inspector edits are commits through validated bridge contracts, never local project mutations.
  function heading(text) { const el = ui.node('div', 'section-label', text); ui.$('inspector').append(el); return el; }

  function numericControl(parent, label, value, min, max, step, commit, extra) {
    const row = ui.node('div', 'control-row'), name = ui.node('label', '', label), input = ui.node('input');
    input.type = 'number';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = Number(value.toFixed(4));
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => commit(Number(input.value)));
    row.append(name, input);
    if (extra)
      row.append(extra);
    parent.append(row);
    return input;
  }

  function textStyleControls(parent, style, commit) {
    for (const [field, label, min, max, step] of [['fontSize', 'Font size', 8, 512, 1], ['x', 'Anchor X', 0, 1, .01], ['y', 'Anchor Y', 0, 1, .01], ['opacity', 'Text opacity', 0, 1, .01], ['outlineWidth', 'Outline width', 0, 20, 1], ['backgroundOpacity', 'Box opacity', 0, 1, .01], ['padding', 'Box padding', 0, 32, 1], ['lineSpacing', 'Line spacing', 0, 64, 1]])
      ui.numericControl(parent, label, style[field], min, max, step, (value) => commit({ [field]: value }));
    for (const [field, label] of [['color', 'Text color'], ['outlineColor', 'Outline color'], ['backgroundColor', 'Box color']]) {
      const row = ui.node('label', 'control-row', label), input = ui.node('input');
      input.type = 'color';
      input.value = style[field];
      input.setAttribute('aria-label', label);
      input.addEventListener('change', () => commit({ [field]: input.value }));
      row.append(input);
      parent.append(row);
    }
    for (const [field, options] of [['align', ['left', 'center', 'right']], ['verticalAlign', ['top', 'middle', 'bottom']]]) {
      const row = ui.node('label', 'control-row', field === 'align' ? 'Horizontal' : 'Vertical'), input = ui.node('select');
      input.setAttribute('aria-label', field);
      for (const value of options) {
        const option = ui.node('option', '', value);
        option.value = value;
        input.append(option);
      }
      input.value = style[field];
      input.addEventListener('change', () => commit({ [field]: input.value }));
      row.append(input);
      parent.append(row);
    }
  }
  Object.assign(ui, { tc, toast, node, button, heading, numericControl, textStyleControls });
}
