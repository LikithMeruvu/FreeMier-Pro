# panels/transitions

The transition panel exposes the shared service's source-handle-aware video dissolve and audio crossfade operations. It edits the owning project through standard commands and renders authored intervals over the timeline. The program monitor decodes hidden source handles and blends processed endpoint layers with premultiplied weights; audio preview uses the same linear weights.

The current profile requires chronological adjacent clips on one track, frame-aligned timing, sufficient real source handles, static transforms and no enabled clip fades. Wipes, plug-ins, speed changes and invented or frozen handles are unsupported. Engine, export and Electron acceptance checks define the implemented boundary.

See the [folder guide](../../../../../FOLDER-STRUCTURE.md) and [current support](../../../../../docs/STATUS.md).
