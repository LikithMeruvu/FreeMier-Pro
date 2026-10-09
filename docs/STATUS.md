# Current support

Updated 9 October 2026. FreeMier Pro is a **developer source preview**, not a production-ready desktop editor.

## Available features

| Area | Working support |
|---|---|
| Project | Visible New Project/settings; name/dimensions edits with undo; frame-rate changes on an empty authored timeline; load/save copied-media directories; project validation; schema-1/legacy `.palmier` |
| Media | Local file probing/import, thumbnails and waveforms; nested bins, metadata, search/filter/sort/paging, identity/file checks and explicit relink; compatibility depends on installed FFmpeg/ffprobe |
| Timeline | Aligned video/audio pair placement, link/unlink and atomic timing edits; independent clips; add/move/split/trim/delete/duplicate; slip/roll; visible track rename/reorder/remove, mute/lock; zoom/fit/snapping |
| Monitors | Source in/out ranges and insertion; Program preview; decoded paused frame seeking |
| Animation | Position, scale, rotation and opacity keyframes; hold, linear and eased interpolation |
| Effects | Color adjustment, grayscale, sepia, blur, sharpen, video fade and audio fade; ordered stacks and bypass |
| Transitions | Adjacent same-track video dissolve and linear audio crossfade; real source handles, frame length and center/start/end alignment; visible editing, locks, undo and preview/export |
| Markers | Frame-aligned sequence markers with labels, colors and notes |
| Titles | Static styled multiline titles using bundled Noto Sans Regular |
| Captions | One editable plain SRT track; import/export, timing and style; burn-in, no captions or SRT sidecar |
| Presets | Descriptive portable `.fmfx.json` effect stacks; inspect, import, search, apply, capture, export and remove |
| Workspace | Persistent panel visibility/sizes, Edit/Color/Audio mode, browser tab, zoom/snap/grid, and named layout save/apply/delete; independent of project history |
| MCP and GUI | 94 standard MCP tools; desktop controls and agents share one owning project store; changes appear live |
| Output | CPU FFmpeg export, including H.264/HEVC when the required encoder is installed |

## Checks

The suite includes **377 tests in 30 files**, **40 baseline live Electron checks**, **one standalone font check**, a project/track-control desktop suite, **10 linked-media Electron checks**, and media organisation, transition and workspace-settings desktop workflows. These all passed on Windows on 9 October. Tests use generated media, fully decoded video/audio, a real standard MCP connection, desktop controls, saved projects and actual exports. Test files run sequentially to bound concurrent FFmpeg encoder workloads.

The preceding linked-media/project-control milestone passed Windows checks and [Linux CI](https://github.com/LikithMeruvu/FreeMier-Pro/actions/runs/37807515970). Media organisation adds ten commands and one optional `binId` field to `media_import`; existing names and other original inputs remain compatible. This new milestone also passed [Linux CI on its exact implementation commit](https://github.com/LikithMeruvu/FreeMier-Pro/actions/runs/37812909590), including build, tests and actual Electron/Xvfb acceptance. Planned folders are documented rather than counted as completed features. See the [folder map](../FOLDER-STRUCTURE.md) and [27-area tracker](FEATURE-COMPLETION.md).

Current automated results are available in [GitHub Actions](https://github.com/LikithMeruvu/FreeMier-Pro/actions/workflows/verify.yml). Repeatable desktop startup and supported-platform verification remain part of release reliability work. Counts describe the available checks, not a guarantee that every run or editing workload succeeds.

The transition milestone adds five commands without changing the previous 82 input schemas. Its Windows checks include actual blended pixels, complementary sound, transparent layers, rotation, real stream-handle checks and reversed saved clip order. The build, all 353 tests and all actual Electron/Xvfb workflows also passed [Linux CI on the verified repair commit](https://github.com/LikithMeruvu/FreeMier-Pro/actions/runs/37946475018), including the independent audio-clip decoding regression. See [transition support](TRANSITIONS.md).

## Current limits

- Linked editing supports one aligned video/audio pair from the same audio-bearing video. Offset/multiple-audio groups and non-mirrored ripple propagation are unavailable. Existing `clip_add` stays independent. See [linked editing](LINKED-MEDIA.md).
- Frame-rate changes with authored timing are refused until timeline conversion is implemented. Dimension acceptance does not guarantee every codec supports the requested size.
- Blur/sharpen and browser scaling/color conversion can differ from exported pixels. These spatial previews are approximations.
- Splitting or changing the head of a clip with affected keyframes or enabled fades is refused until animation rebasing is implemented. Slip/move/duplicate retain clip-local animation.
- Titles use one bundled font with an initial Latin/Greek/Cyrillic scope. Arbitrary fonts, rich text and animated text are planned.
- Captions support one track and up to 256 non-overlapping plain-text cues. WebVTT/ASS, word-level editing and automatic transcription are planned.
- Presets support the seven built-in effects. LUTs, vendor presets, animated templates, transition masks and executable OFX/VST3/LV2 plugins require additional support.
- Project media organisation supports ordinary bins and explicit hash-verified relink. Legacy files without identity require compatible media facts and explicit consent. Saved search bins, XMP writes, external indexes and cancellable scans remain unavailable. See [media organisation](MEDIA-ORGANISATION.md).
- Dissolves require matching constant source/sequence video rates and static participant transforms without enabled fades. Mixed/variable-rate dissolves, wipes, transition assets and plugins remain unsupported.
- Nested sequences, proxies, multicam, interchange, advanced grading/mixing, local AI and GPU rendering remain planned.
- Workspace settings have seven standard commands and persist separately from projects. Actual Electron checks cover remote changes, responsive panel sizes, named layouts, live service reconnect, app restart and backed-up recovery of invalid settings. Linux verification of this new milestone is pending. See [workspace settings](WORKSPACE-SETTINGS.md).
- Source/transport selection remains local presentation state. Additional MCP presentation controls and exact composited image output are planned.
- Installation packages, recovery/autosave, export overwrite/cancel protection, desktop session hardening and sustained real-footage/performance trials remain open.

See [preset details](PRESETS.md), the [development roadmap](../ROADMAP.md) and [release requirements](RELEASE-READINESS.md).
