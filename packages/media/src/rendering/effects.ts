import type { Effect, Transform } from '@freemier/shared';
import { animationExpression, effectDescriptor, validateEffectParams, validateTransformValue } from '@freemier/shared';

const f = (n: number) => Number(n.toFixed(8)).toString();
/** Fixed-size inverse affine sampling supports all curves without resizing frames. */
export function animatedTransformFilter(transform: Transform): string {
  for (const [name, curve] of Object.entries(transform)) {
    validateTransformValue(name as keyof Transform, curve.value);
    for (const key of curve.keyframes) validateTransformValue(name as keyof Transform, key.value);
  }
  const x = animationExpression(transform.x), y = animationExpression(transform.y);
  const scale = animationExpression(transform.scale), rotation = `(${animationExpression(transform.rotation)}*PI/180)`;
  const dx = `(X-W/2-(${x})*W)`, dy = `(Y-H/2-(${y})*H)`;
  const sx = `((cos(${rotation})*${dx}+sin(${rotation})*${dy})/(${scale})+W/2)`;
  const sy = `((-sin(${rotation})*${dx}+cos(${rotation})*${dy})/(${scale})+H/2)`;
  return `geq=r='r(${sx},${sy})':g='g(${sx},${sy})':b='b(${sx},${sy})':a='if(between(${sx},0,W-1)*between(${sy},0,H-1),alpha(${sx},${sy})*(${animationExpression(transform.opacity)}),0)'`;
}
/** Only typed, bounded parameters reach filters; no raw user expressions. */
export function effectFilters(effects: readonly Effect[], media: 'video' | 'audio'): string[] {
  const filters: string[] = [];
  for (const effect of effects) {
    if (!effect.enabled) continue;
    const descriptor = effectDescriptor(effect.type), p = validateEffectParams(effect.type, effect.params);
    if (descriptor.media !== media) continue;
    if (effect.type === 'color_adjust') {
      const adjusted = (channel: string) => `pow(clip((${channel}(X,Y)/255-0.5)*${f(Number(p.contrast))}+0.5+${f(Number(p.brightness))},0,1),${f(1 / Number(p.gamma))})`;
      const r = adjusted('r'), g = adjusted('g'), b = adjusted('b');
      const luma = `(0.2126*${r}+0.7152*${g}+0.0722*${b})`;
      const output = (value: string) => `255*clip(${luma}+(${value}-${luma})*${f(Number(p.saturation))},0,1)`;
      filters.push(`format=gbrap,geq=r='${output(r)}':g='${output(g)}':b='${output(b)}':a='alpha(X,Y)'`);
    } else if (effect.type === 'grayscale') {
      const luma = '(0.2126*r(X,Y)+0.7152*g(X,Y)+0.0722*b(X,Y))';
      filters.push(`format=gbrap,geq=r='${luma}':g='${luma}':b='${luma}':a='alpha(X,Y)'`);
    } else if (effect.type === 'sepia') {
      const amount = Number(p.amount), mix = (channel: string, r: number, g: number, b: number) => `clip(${f(1 - amount)}*${channel}(X,Y)+${f(amount)}*(${r}*r(X,Y)+${g}*g(X,Y)+${b}*b(X,Y)),0,255)`;
      filters.push(`format=gbrap,geq=r='${mix('r', .393, .769, .189)}':g='${mix('g', .349, .686, .168)}':b='${mix('b', .272, .534, .131)}':a='alpha(X,Y)'`);
    } else if (effect.type === 'blur' && Number(p.radius) > 0) filters.push(`gblur=sigma=${f(Number(p.radius))}:planes=7`);
    else if (effect.type === 'sharpen') filters.push(`unsharp=5:5:${f(Number(p.amount))}:5:5:0`);
    else if (effect.type === 'video_fade') filters.push(`format=rgba,fade=t=${p.direction}:st=${f(Number(p.start))}:d=${f(Number(p.duration))}:alpha=1`);
    else if (effect.type === 'audio_fade') filters.push(`afade=t=${p.direction}:st=${f(Number(p.start))}:d=${f(Number(p.duration))}`);
  }
  return filters;
}
