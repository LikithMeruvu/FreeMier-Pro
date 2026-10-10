# Project input contract

FreeMier Pro still writes schema version 1 in `project.json` inside a `.freemier` directory. Legacy `.palmier` directories and optional marker/title/caption/link extensions remain supported. Validation preserves accepted snapshots rather than sorting, filling defaults or migrating them silently.

The same validator guards project creation, store construction/load/candidate mutations, JSON save/load and export argument construction/execution. Invalid snapshots produce an `EditorError` with a stable code and field path. Refusal occurs before history changes, notifications, project-file writes or native text/export work. Unknown additive JSON fields survive valid save/load.

## Supported data

- Project/timeline identities, names and epoch-millisecond timestamps have the declared types. Versions must be positive integers; a future schema produces `UNSUPPORTED`.
- Sequence rates use the current GUI/timecode scope of 1–240 fps, including fractional rates. Width/height are positive safe integers. This structural acceptance does not establish that every size is supported by the selected codec or performs well.
- Media IDs are unique, bounded and safe as filename components. Media metadata has finite durations/rates, integer dimensions and typed codec/audio fields. Audio-only assets may have zero dimensions. Relative copied-media paths cannot traverse above the media directory; already-resolved absolute copied paths remain supported. Validation does not probe existence or verify stream metadata.
- Track IDs and sequence-wide clip IDs are unique. Track kinds, mute/lock/order and clip collections are typed. Clips reference existing media, have positive duration and nonnegative finite positions/source ranges, and do not overlap on a track. The current unit-speed source window must match clip duration. Nearest-frame source-end rounding retains its existing half-frame tolerance.
- Transform curves require all five properties, supported value bounds, at most 256 keys per property, nonnegative finite times, unique times and supported easing. Input keys and clips can remain unsorted. Tail-trimmed curves with later keys retain the existing clamped evaluation behavior.
- Effect stacks have at most 32 entries with per-clip unique IDs, boolean enable state and finite scalar parameters. Known effects use their existing parameter schemas. Unknown effect data is preserved for project compatibility; an enabled unknown effect still fails export explicitly.
- Optional markers, titles and caption data retain their existing frame/millisecond, count, style, uniqueness and lock-compatible schema checks.
- Optional `timeline.clipLinks` contains `{ id, videoClipId, audioClipId }` records. Members must exist on video/audio tracks, share an audio-bearing video asset and have identical start/duration/source ranges. IDs are unique; a clip can belong to one pair. Legacy projects without links remain independent. See [linked editing](LINKED-MEDIA.md).
- Optional `effectPresets` stores up to 64 normalized portable preset records, each with a canonical SHA-256 identity and import timestamp. Payload/identity mismatches and duplicate identities refuse at the same boundaries. Applied effects are independent of library records; older schema-1 projects without a library keep their exact shape. The [preset format](PRESETS.md) specifies the supported data.

## Remaining reliability work

Structural validation does not provide concurrent-owner protection, export overwrite/cancel protection or a hardened desktop session. Autosave/recovery protection and explicit verified relinking are separate, verified behaviours ([project protection](PROJECT-PROTECTION.md), [media organisation](MEDIA-ORGANISATION.md)). Validation traverses the candidate snapshot; large-project performance needs dedicated trials. See [release readiness](RELEASE-READINESS.md).
