# Current support

Updated 7 October 2026. FreeMier Pro is a **developer source preview**, not a production-ready desktop editor.

## Available features

| Area | Working support |
|---|---|
| Project | Create, load and save; copied-media project directories; undo/redo; project input validation; schema-1 and legacy `.palmier` directories |
| Media | Local file probing/import, thumbnails and audio waveforms; compatibility depends on installed FFmpeg/ffprobe |
| Timeline | Separate video/audio tracks; add/move/split/trim/delete/duplicate clips; slip and rolling trim; track mute/lock; zoom, fit and snapping |
| Monitors | Source in/out ranges and insertion; Program preview; decoded paused frame seeking |
| Animation | Position, scale, rotation and opacity keyframes; hold, linear and eased interpolation |
| Effects | Color adjustment, grayscale, sepia, blur, sharpen, video fade and audio fade; ordered stacks and bypass |
| Markers | Frame-aligned sequence markers with labels, colors and notes |
| Titles | Static styled multiline titles using bundled Noto Sans Regular |
| Captions | One editable plain SRT track; import/export, timing and style; burn-in, no captions or SRT sidecar |
| Presets | Descriptive portable `.fmfx.json` effect stacks; inspect, import, search, apply, capture, export and remove |
| MCP and GUI | 67 standard MCP tools; desktop controls and agents share one owning project store; changes appear live |
| Output | CPU FFmpeg export, including H.264/HEVC when the required encoder is installed |

## Checks

The suite includes **214 tests in 14 files**, **40 live Electron checks** and **one standalone font check**. Full acceptance has passed on Windows and Linux. Tests use generated media, decoded video pixels/audio, a real standard MCP connection, desktop controls, saved projects and actual video exports.

Current automated results are available in [GitHub Actions](https://github.com/LikithMeruvu/FreeMier-Pro/actions/workflows/verify.yml). A subsequent Linux run reported a graphics/CDP timeout during desktop startup; repeatable desktop startup remains part of release reliability work. Counts describe the available checks, not a guarantee that every run or editing workload succeeds.

## Current limits

- Video and audio tracks are separate. Place an audio-bearing asset on an audio track to include its sound; linked audio/video is planned.
- Blur/sharpen and browser scaling/color conversion can differ from exported pixels. These spatial previews are approximations.
- Splitting or changing the head of a clip with affected keyframes or enabled fades is refused until animation rebasing is implemented. Slip/move/duplicate retain clip-local animation.
- Titles use one bundled font with an initial Latin/Greek/Cyrillic scope. Arbitrary fonts, rich text and animated text are planned.
- Captions support one track and up to 256 non-overlapping plain-text cues. WebVTT/ASS, word-level editing and automatic transcription are planned.
- Presets support the seven built-in effects. LUTs, vendor presets, animated templates, transition masks and executable OFX/VST3/LV2 plugins require additional support.
- Transitions, nested sequences, bins, proxies, multicam, interchange, advanced grading/mixing, local AI and GPU rendering remain planned.
- GUI workspace/source/transport selection is currently local presentation state. Additional MCP presentation controls and exact composited image output are planned.
- Installation packages, recovery/autosave, export overwrite/cancel protection, desktop session hardening and sustained real-footage/performance trials remain open.

See [preset details](PRESETS.md), the [development roadmap](../ROADMAP.md) and [release requirements](RELEASE-READINESS.md).
