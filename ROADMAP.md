# FreeMier Pro development roadmap

FreeMier Pro is an independent video editor for Windows and Linux. Each editing feature should work through standard MCP commands and the live desktop interface, using the same project data. The table distinguishes working features from planned work.

| Milestone | Scope | State |
|---|---|---|
| Foundation | Headless engine, media, persistence, undo/redo, live GUI, H.264/HEVC export | Working baseline |
| Professional editing | Source/program monitors, usable timeline tools, slip/roll/duplicate, track locks, effect/animation rendering | Verified Windows and Linux milestone |
| Compositing and text | Markers, transitions, titles, captions/subtitles, masks, nested compositions | Markers, titles and SRT captions verified on Windows/Linux; transitions/masks/nests pending |
| Media workflows | Bins, sequences, linked AV, proxies/relinking, multicam, interchange | Planned |
| Editing and harness completion | Ripple/slide/overwrite, atomic batches, speed/reverse, source/program presentation and rendered-frame tools | Planned |
| Color and audio | Scopes, richer grading, LUTs, automation, mixing, loudness | Planned |
| Local AI | Transcription/tracking/background removal with optional provider keys | Planned |
| Delivery | Export queue/presets, packaging, GPU paths with CPU fallback, native Linux testing | Planned |
| Creative imports | Descriptive resources; portable/vendor effect presets; fonts/animated templates/transition masks; LUT/CDL/interchange adapters; isolated native plugin hosts | Portable built-in effect presets verified on Windows/Linux; wider formats planned with explicit adapter dependencies |

A feature is complete when its editing rules, MCP commands, desktop controls and preview/export where applicable work and pass the relevant checks. Planned items are not available in the current application. See [current support](docs/STATUS.md).

Public testing and production release gates are tracked in [release readiness](docs/RELEASE-READINESS.md); packaging and reliability are separate from advanced feature coverage.

Import support is added format by format. `import_capabilities` lists the current handlers and limits. Imported resources should have descriptions, editable settings and clear compatibility information. See the [working preset format](docs/PRESETS.md). File recognition alone does not establish usable preview or export.
