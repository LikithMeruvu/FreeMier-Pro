# Linked video and audio

An audio-bearing video can place two clips: picture on a video track and sound on an audio track. The link keeps their start, length and source range equal. This is the supported initial profile; offset groups and multiple-audio groups are unavailable.

## In the desktop app

Open a source, mark its in/out points and choose a video track. **Video + audio** places a linked pair using the first unlocked audio track. Timeline drag/drop uses the same placement rule. Add or unlock an audio track if none is available; placement will refuse rather than silently leave out sound.

**Video only** creates an independent picture clip. **Audio only**, or an audio target in automatic mode, places sound independently. Video-only placement requires a video target.

Selecting a pair highlights both members and shows a link mark. Move, cut, trim, slip, roll, duplicate and delete keep members together. Either member can be the editing target. Use **Unlink video + audio** to edit independently. **Link video + audio** links matching unlinked clips; if several match, a dialog lets you choose the sound. A match must use the same source asset and have the same timing and source range.

A locked partner refuses edits. Rolling trim needs two corresponding adjacent pairs. Ripple operations must preserve alignment of all affected pairs; unsupported one-sided propagation refuses the whole edit. Tracks containing linked members must be unlinked or emptied before removal. Existing keyframe/fade origin-change restrictions still apply.

Each operation creates one undo step. Links survive save/open. Picture decoders are muted; only audio-track clips enter the audio mix, preventing the video's sound from being included twice.

## Through MCP

All standard MCP clients can use these commands. `editor_capabilities` describes the profile and limits; `timeline_inspect` returns `clipLinks`; `clip_inspect` returns the selected clip, link and partner.

| Command | Inputs | Result |
| --- | --- | --- |
| `clip_add_linked` | `assetId`, `videoTrackId`, `audioTrackId`; optional `start`, `duration`, `sourceIn`, `label`, `strict`, `ripple` | `videoClip`, `audioClip`, `link` |
| `clip_link` | `videoClipId`, `audioClipId` | Existing members and their new `link` |
| `clip_unlink` | Either member's `clipId` | `unlinked`; false when no link exists |

Existing timing commands act on both members when their target is linked, preserving their result shapes. `clip_add` remains independent for compatibility. Visual transforms/effects and clip volume remain member-specific.

```json
{
  "name": "clip_add_linked",
  "arguments": {
    "assetId": "asset-id-from-media-import",
    "videoTrackId": "video-track-id",
    "audioTrackId": "audio-track-id",
    "start": 0,
    "sourceIn": 1,
    "duration": 2,
    "strict": true
  }
}
```

Project name/dimensions can be changed with `project_update`. Frame-rate changes are refused while clips, titles, captions or markers exist because timeline retiming is not implemented. `track_reorder` moves one visible position up/down with undo; both neighboring tracks must be unlocked.

## Verification

Engine tests cover paired operations from either member, source/overlap/lock refusals, atomic rollback, mirrored ripple, undo/redo and persistence. Standard SDK stdio checks save/reopen copied media and fully decode rendered frames/audio, checking source windows, gaps, duration and audio level. Actual Electron checks cover source/drop placement, selection, all paired timing controls, link choices, locks, audible decoded preview, portable save/open and export.

These checks establish this aligned-pair profile. They do not establish production readiness or support for all camera/audio formats. See [current support](STATUS.md) and [the 27-area tracker](FEATURE-COMPLETION.md).
