# Transitions

A transition joins two neighbouring clips. A **video dissolve** gradually changes one picture into the next. An **audio crossfade** gradually changes one sound into the next. The supported profile passed Windows and Linux acceptance; consult the [completion tracker](FEATURE-COMPLETION.md) for platform evidence.

Both clips stay in their original positions. The cut and total project length stay the same. The editor reads extra picture frames or sound samples from the source files around that cut. If there is not enough source material, it refuses the transition rather than inventing frames.

## Desktop controls

The Transitions panel selects the left and right clips, type, length in sequence frames and alignment. Add creates a transition; selecting an existing entry allows Update or Remove. The timeline shows the occupied interval. Undo restores the previous transition and its settings. A video transition and its audio companion are separate choices.

## MCP commands

| Command | Purpose |
| --- | --- |
| `transition_add` | Choose `leftClipId`, `rightClipId`, `type`, `durationFrames` and optional `alignment`. |
| `transition_update` | Change `durationFrames` or `alignment` using `transitionId`. |
| `transition_remove` | Restore the original hard cut without moving either clip. |
| `transition_list` | Read transitions and their calculated source/timeline windows; optionally filter by `trackId` or `clipId`. |
| `transition_catalog` | Read available types, limits and unsupported combinations. |

Mutations accept an optional `expectedRevision` to refuse an edit when the project has changed. The listed entries contain the stored `transition` and calculated `start`, `end`, `cut`, `leftWindow` and `rightWindow`. These calculated windows are not written over the clips' original source ranges.

Example at 30 fps: `durationFrames: 12` lasts 0.4 seconds. `center` places six frames before the cut and six after; `start` places all twelve after; `end` places all twelve before. For an odd centred length, the extra frame is after the cut. These alignment choices follow the ordinary [cut-alignment convention](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-transitions/align-transitions.html).

## Supported profile and limits

- Two adjacent, unit-speed clips on the same matching video or audio track; frame-aligned positions and source ranges. Video dissolves require constant source frame rates matching the sequence and verified source frame timestamps. Images and independent audio crossfades are exempt from the video rate requirement. Mixed-rate or variable-rate video dissolves need further timing support. Length is at least two frames and cannot exceed either visible clip's length.
- Static position, scale, rotation, opacity and supported static effects. Picture and alpha are mixed with complementary weights into one layer before compositing over lower tracks.
- Audio uses complementary linear gains and retains each clip's volume. It is not an equal-power crossfade.
- Up to 256 transitions. Intersecting transition intervals on one track are refused. Different tracks may have transitions at the same time.
- Participant and linked partner locks protect transition edits. Locking an existing transition's track remains valid for save and playback.
- Clip edits that would break adjacency or remove required handles are refused. Remove the transition first. Source files are never changed.
- Participating transform keyframes and enabled clip fades are currently refused. Wipes, arbitrary transition assets, vendor transition presets and executable plugins are not supported by this profile.
- Export checks decoded selected-stream coverage, with bounded reads and a per-probe timeout. Missing, interrupted or unverifiable source handles are refused. This is stronger than relying on a container's advertised length. Browser preview remains dependent on its decoders; blur/sharpen and browser colour conversion keep their documented approximation limits.

The optional `timeline.transitions` project extension preserves legacy schema-1 projects that omit it. Engine rules live in [transition operations](../packages/engine/src/transitions/operations.ts), common calculations in [shared helpers](../packages/shared/src/calculations/transitions.ts), native output in [media rendering](../packages/media/src/rendering/transitions.ts), and visible controls in [the panel](../packages/gui/src/panels/transitions/transitions.js).
