# FreeMier Pro folder structure

Updated 9 October 2026. This is the main guide to where code belongs. Update it whenever development changes the structure.

**The folders are organised now. A folder name does not mean its feature is finished.** README-only folders reserve places for planned code. See [current support](docs/STATUS.md) for what works.

## The six main folders

```text
FreeMier-Pro/
  packages/
    gui/       The Electron window, buttons and visible panels
    engine/    The code that changes the editing project
    media/     Reads video/sound and makes the final video
    service/   One editing session shared by the window and AI
    mcp/       The standard connection through which AI sends requests
    shared/    Common project fields, calculations and error messages
  assets/      Bundled resources and their licences
  docs/        Instructions for users, developers and AI agents
  scripts/     Setup, build and checking helpers
  examples/    Example MCP connection settings
  fixtures/    Locally generated test media; media is kept out of Git
  .github/     Checks that run on GitHub
```

`src` means source code we edit. `test` means checks for that code. `dist` contains generated runnable files; never edit those directly. `node_modules` contains installed dependencies.

## How an edit travels

```text
You click in GUI ───────────────┐
                              ├─> service ─> engine ─> ONE project store
An AI sends an MCP request ────┘                         │
                                                       └─> GUI updates

Save:   service ─> project files and copied media
Export: service ─> media ─> FFmpeg ─> finished video
```

The engine records editing decisions. FFmpeg reads the actual pictures and sound and makes the output. The service coordinates the work. MCP and GUI provide two ways to request the same edit.

The GUI is optional when an agent edits without a window. When opened, it attaches to the existing session or starts a standalone session. Its selection, playhead and panel choices are display state; it does not own another editable timeline.

## GUI: the screen

```text
packages/gui/
  desktop/
    main.ts          Starts Electron; handles windows, dialogs and native actions
    preload.cjs      Gives the screen a small set of desktop actions
  index.html         The screen layout and panel containers
  src/
    workspace/
      main.js        Starts the screen and connects its modules
      state.js       Display state and decoded-media caches
      events.js      Common shortcuts and workspace buttons
      transport.js   Play, pause, seeking and selection
      projects.js    New, settings, Open and Save requests
    connection/client.js  Sends commands and receives the current project
    components/controls.js Reusable buttons, inputs, labels and messages
    styles/app.css        Colours, sizes, spacing and appearance
    panels/
      project/          Bins, metadata, search, paging, file checks, relink and import controls
      source-monitor/   Source playback and source in/out points
      program-monitor/  Edited video preview and sound playback
      timeline/         Tracks, clips, mouse edits and snapping
      effect-browser/   Available effects and search
      effect-controls/  Settings for effects on the selected clip
      keyframes/        Motion controls and animation curves
      color/            Colour adjustment controls
      audio/            Clip volume and live audio gain
      titles/           Title list and styling controls
      captions/         Subtitle list, timing and styling
      presets/          Browse and apply project effect presets
      markers/          Timeline notes
      export/           Export controls and progress
      transitions/      Video dissolve/audio crossfade controls, timing and selection
      personal-library/ Reserved: reusable user resources across projects
      jobs/             Reserved: background tasks and cancellation
      scopes/           Reserved: colour/audio measurements
      plugins/          Reserved: installed plugin controls
      settings/         Reserved: preferences and saved workspace layouts
  test/acceptance/    Checks that open and operate the real Electron app
```

**Yes: panel folders contain visible editor controls**, like the areas in your example image. We can show several panels together or use tabs. Each folder does not need a permanent box on screen.

Each working panel has its named file, such as `timeline/timeline.js` or `presets/presets.js`. Where needed, `events.js` handles that panel's clicks. `effect-browser/browser.js` finds effects; `effect-controls/inspector.js` changes their settings. Preview lives in `program-monitor/program.js`, using browser decoders and shared calculations. A native preview renderer belongs in the reserved media preview folder when implemented.

The desktop wrapper is separate from panel code so the headless editor does not depend on Electron. Heavy panel resources should load when needed. Folder organisation alone does not establish low-end hardware performance or make Electron a plugin for every host.

## Engine: the editing rules

```text
packages/engine/src/
  project/
    store.ts        Owns the project and sends change notifications
    persistence.ts  Reads/writes project JSON and handles legacy paths
    settings.ts     Changes project name/dimensions; safely checks frame-rate changes
    validation.ts   Checks project data before accepting it
  history/snapshots.ts Keeps bounded undo and redo snapshots
  library/assets.ts   Imports asset records; manages bins, metadata, queries and location changes
  timeline/
    tracks.ts       Adds/removes/reorders tracks without reversing unrelated layers
    operations.ts   Changes track settings
    queries.ts      Finds clips, gaps, timing and duration
    inspect.ts      Returns a complete timeline description
  clips/
    operations.ts   Adds, cuts, moves, trims and removes clips
    advanced.ts     Duplicates clips; handles slip and rolling trim
    guards.ts       Common checks for locks, bounds and editing targets
  motion/operations.ts    Position, size, rotation and transparency
  keyframes/operations.ts Adds/removes animation points
  effects/operations.ts   Adds, changes, removes and applies effect stacks
  audio/operations.ts     Current clip volume and label
  titles/operations.ts    Adds, updates and removes static titles
  captions/operations.ts  Subtitle text, timing and style
  markers/operations.ts   Timeline notes
  presets/operations.ts   Captures, validates, imports and applies effect presets
  linked-media/operations.ts Aligned sound/picture pairs and atomic paired edits
  sequences/        Reserved: multiple and nested timelines
  multicam/         Reserved: switching between camera angles
  speed/            Reserved: speed changes, reverse and time remapping
  transitions/operations.ts Adds/updates/removes transitions with handles, locks and undo
  compositing/      Reserved: masks, blending, overlays and tracking data
  color/            Reserved: grading, LUT and colour-management rules
  resources/        Reserved: imported fonts, LUTs and template references
  analysis/         Reserved: tracking, stabilisation and AI result application
  recovery/         Reserved: autosave and recovery rules
  index.ts          Shares the working engine functions
```

Current colour changes are built-in effects, so their rules live in `effects/operations.ts`. Layered clips already work through tracks. Reserved folders will own richer behaviour when developed. `audio/operations.ts` is not a complete mixer. Animated text still needs editing rules, rendering, controls and tests. Transitions have a bounded dissolve/crossfade implementation; see [transition support](docs/TRANSITIONS.md) for its limits and acceptance state.

Put feature checks in `packages/engine/test/<feature>/`. `test/integration/` checks edits involving several features together.

`test/linked-media/` covers paired edits, rollback, locks, ripple propagation and saved links. `test/project/settings.test.ts` covers project settings and track ordering. Electron checks in `gui/test/acceptance/linked-media.mjs` and `project-tracks.mjs` exercise the actual visible controls. Linked editing currently supports one aligned video/audio pair, not offset or multiple-audio groups.

`test/library/organisation.test.ts` checks bins, metadata, searches, undo, validation and old project compatibility. `gui/test/acceptance/media-organisation.mjs` operates the visible library controls and verifies relink, save/reopen and decoded media.

## Media: pictures, sound and export

The old `ffmpeg` package is now **media** because it does more than export. FFmpeg is one provider inside it.

```text
packages/media/src/
  import/media.ts          Reads file information and imports/copies media
  thumbnails/extract.ts    Makes thumbnails
  waveforms/extract.ts     Reads sound samples and makes waveform peaks
  rendering/effects.ts     Converts effects/keyframes into render instructions
  rendering/text.ts        Makes title/caption images from the bundled font
  rendering/transitions.ts Blends transition layers and checks actual source handles
  export/export.ts         Builds output settings and renders the timeline
  identity/source.ts       Streaming file identity, availability and bounded candidate discovery
  providers/ffmpeg/run.ts   Starts FFmpeg/ffprobe using argument arrays
  preview/                 Reserved: native preview frames and caching
  proxies/                 Reserved: smaller editing copies of large media
  codecs/                  Reserved: capability checks and format adapters
  rendering/compositing/   Reserved: richer native blending and mask rendering
  providers/plugins/       Reserved: isolated effect/audio plugin hosts
  providers/ai/            Reserved: local models and optional user API providers
  providers/gpu/           Reserved: GPU processing with CPU fallback
  index.ts                 Shares working media functions
```

Media works on files; it does not own the editing project. Tests in `test/identity/`, `test/integration/`, `test/effects/` and `test/text/` check actual metadata, decoded output, sound and text rendering.

## Service: the common editing session

```text
packages/service/src/
  session/session.ts       Creates one store and resolves one workspace directory
  commands/
    context.ts             Defines what a command can use
    registry.ts            Collects commands in the existing public order
    project.ts             Project create/info/settings/save/load and track reorder requests
    history.ts             Undo and redo requests
    media.ts               Probe/import/thumbnail/waveform requests
    media-library.ts       Bin, metadata, query, availability and relink requests
    tracks.ts              Track requests
    timeline.ts            Timeline queries
    clips.ts               Basic clip editing requests
    linked-media.ts        Paired placement, link and unlink requests
    transitions.ts         Transition add/update/remove/list and supported-type catalogue
    advanced-clips.ts      Slip, rolling trim and duplicate requests
    keyframes.ts           Animation requests
    effects.ts             Effect requests
    capabilities.ts        Current effect/control descriptions
    export.ts              Export and export-plan requests
    markers.ts             Marker requests
    titles.ts              Title requests
    captions.ts            Subtitle requests
    presets.ts             Preset inspect/import/search/apply/export requests
    helpers.ts             Common responses and media-path helpers
  connection/bridge.ts     Live updates, GUI commands and media routes
  persistence/projects.ts  Packages copied media on save and opens projects
  jobs/export.ts           Coordinates native exports and progress
  library/relink.ts        Verify replacement files and switch one asset location atomically
  library/import/presets.ts Reads bounded portable effect-preset files
  library/catalog/         Reserved: searchable descriptions of user resources
  library/storage/         Reserved: personal resource storage and references
  library/export/          Reserved: portable resource bundles
  library/dependencies/    Reserved: required fonts, plugins and other resources
  plugins/                 Reserved: plugin discovery and lifecycle
  index.ts                 Shares the session, bridge and commands
```

Commands keep their name, description and input fields here. GUI and MCP use the same handlers. Editing rules belong in engine; native file processing belongs in media. Service joins them. Export progress works today; a full queue and cancellation remain planned.

`test/session/` checks that MCP and GUI requests use the exact same store and workspace. `test/connection/` checks live updates, media routes and failures. `test/library/` checks native relink, retained copies, concurrent-edit refusals and cache recovery.

## MCP: the AI connection

```text
packages/mcp/src/
  server/server.ts     Starts standard MCP and connects the shared service
  server/cli.ts        Starts the server from the command line
  tools/list.ts        Supplies names, descriptions and input schemas
  tools/call.ts        Checks a request, calls its command and returns results
  tools/index.ts       Shares the command catalogue
  cli/media-inspect.ts Runs the separate media inspection command
  cli.ts               Keeps the existing MCP startup filename working
  media-cli.ts         Keeps the existing inspection startup filename working
  index.ts             Keeps public imports working
```

Agents still start `packages/mcp/dist/cli.js`. There are 87 tools. Commands do not need to be implemented twice. Tests in `test/stdio/` start the real MCP process; `linked-media.test.ts` uses the standard SDK and decodes exported picture/sound after paired edits and save/reopen. `media-organisation.test.ts` checks bins/search/history, identity, multiple replacement candidates and decoded linked picture/sound after relink and portable reopen. `transitions.test.ts` checks transition discovery, edits, locks, history, portable reopen and decoded blended picture/sound.

## Shared: common definitions

```text
packages/shared/src/
  project/types.ts          Project, timeline, clip, track, media identity and optional library fields
  project/ids.ts            Unique IDs for project items
  calculations/timecode.ts  Frame/time calculations
  calculations/animation.ts Animation curves, limits and easing
  calculations/effects.ts   Effect descriptions, controls and pixel calculations
  calculations/transitions.ts Shared frame intervals, source windows, gains and alpha math
  titles/style.ts           Title and text-style rules
  captions/model.ts         Caption fields and validation
  captions/srt.ts           Reads/writes plain SRT files
  markers/validation.ts     Marker fields and validation
  resources/presets.ts      Preset descriptions, fields and compatibility
  errors/index.ts           Structured error codes and messages
  index.ts                  Shares common definitions
```

Shared does not start Electron, FFmpeg, MCP or another project store.

## Where presets and imported resources go

Program code and a user's imported files are different things. Importing a preset must not write into `packages/` or the public repository.

| Kind | Location and purpose |
|---|---|
| Built-in resources | `assets/`: shipped resources and licences. Today: `fonts/` with Noto Sans, `OFL.txt` and its checksum guide. |
| Project bins and metadata | Optional `mediaLibrary` inside the owning project, saved in `project.json`; media files stay separate. |
| Current project presets | `effectPresets` inside the owning project; saved in that project's `project.json`. This works today. |
| Portable preset file | A `.fmfx.json` file at the user's chosen import/export location. Import reads it into the project. |
| Copied media | Saved `.freemier/media/` directory; move it with `project.json`. Referenced files keep external paths. |
| Personal library | Planned app-data storage outside Git, shared across projects. `service/library/storage/` will manage it; not implemented yet. |
| Portable project resources | Planned `resources/` inside saved projects for fonts, LUTs and templates; the current schema has no general resource bundle. |
| Cache | Workspace `cache/` for rebuildable thumbnails, waveforms and text images. |

The personal library is part of the final product scope now. Its planned categories are:

```text
<user app-data>/FreeMier-Pro/library/
  effect-presets/    audio-presets/     animation-presets/
  luts/              color-presets/     transitions/
  title-templates/   graphics/          fonts/
  captions/          media/             plugins/
  export-presets/    project-templates/ workspace-layouts/
```

Each item should have an ID, name, description, category, tags, source format, required resources, available settings and an honest support result. GUI and MCP should read the same catalogue. Agents should find items, inspect controls, check missing requirements and apply them.

Current `.fmfx.json` files have descriptions, tags, control schemas and compatibility information for seven built-in effects. Other formats need readers or separate providers; putting files in folders does not make them work. See [preset support](docs/PRESETS.md).

## Adding a feature

For a transition, put editing rules in `engine/src/transitions/`, rendering in `media/src/rendering/`, common fields in `shared/`, a described command in `service/src/commands/`, and controls in `gui/src/panels/transitions/`. MCP exposes the command through its existing adapter.

Check edit, undo, save/open, preview, export and AI access where relevant. Extend project fields without breaking saved projects. Keep features in their named folders; avoid large catch-all files.

Keep this guide, [current support](docs/STATUS.md) and [the roadmap](ROADMAP.md) current. Run `npm run check:structure`, build and relevant tests. Run actual Electron checks when changing the screen.
