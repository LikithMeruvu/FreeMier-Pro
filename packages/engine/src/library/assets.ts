import type { MediaAsset } from '@freemier/shared';
import { type EditorStore } from '../project/store.js';

export function addMediaAsset(store: EditorStore, asset: MediaAsset): MediaAsset {
  store.mutate('media', [asset.id], (p) => ({ ...p, media: [...p.media, asset] }));
  return asset;
}
