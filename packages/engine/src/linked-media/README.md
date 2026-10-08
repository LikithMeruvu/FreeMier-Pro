# Linked video and audio

`operations.ts` owns aligned pairs from one audio-bearing video asset. Pair placement, linking/unlinking and clip timing edits validate a temporary snapshot before making one mutation in the owning store.

Core clip operations keep members aligned, reject locked partners and undo together. Split/duplicate create independent pair identities. Save/load preserves the optional schema-1 `clipLinks` field. Unsupported one-sided ripple propagation is refused before changing the project.

The current profile supports one video member and one audio member with identical timing/source ranges. Offset groups and multiple-audio groups are not implemented. See [linked editing](../../../../docs/LINKED-MEDIA.md).
