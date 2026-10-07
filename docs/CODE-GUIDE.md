# FreeMier Pro code guide

This is one application divided into five main code folders. Each folder has a clear job. `packages` simply means a place to group related code.

```text
FreeMier-Pro/
  packages/
    gui/        The editor window you see and use
    engine/     The rules for editing and saving a project
    ffmpeg/     The work with video/audio files and final export
    mcp/        The commands an AI tool can send to the editor
    shared/     Common information used by the other folders
  docs/         Product guides
  scripts/      Small setup and development helpers
  examples/     Example AI connection settings
  .github/      Automatic checks on GitHub
  README.md     How to start and use the project
  ROADMAP.md    What works and what is planned
  package.json  Commands and required software libraries
```

## 1. gui: what you see

This folder controls the desktop window, buttons, panels, timeline and preview. GUI means the screen you click and use.

| File | What it does |
|---|---|
| [renderer/index.html](../packages/gui/renderer/index.html) | Sets up the main screen and its panels |
| [renderer/app.css](../packages/gui/renderer/app.css) | Sets colors, spacing, sizes and appearance |
| [renderer/app.js](../packages/gui/renderer/app.js) | Handles clicks, draws the timeline and preview, and sends editing requests |
| [src/main.ts](../packages/gui/src/main.ts) | Starts the desktop window and handles native file dialogs |
| [src/preload.cjs](../packages/gui/src/preload.cjs) | Gives the screen a small set of desktop actions, such as opening a file picker |
| [test/live-sync.mjs](../packages/gui/test/live-sync.mjs) | Opens the real app and checks clicks, AI changes, preview and export |
| [test/standalone-text.mjs](../packages/gui/test/standalone-text.mjs) | Checks the bundled title font when the app runs by itself |

Electron is the tool that puts this screen inside a desktop application. The screen uses HTML for its layout, CSS for its appearance and JavaScript for its actions.

## 2. engine: how an edit works

The engine decides what a cut, move or trim means. It can work even when the window is closed, so an AI can edit through commands.

| File | What it does |
|---|---|
| [src/store.ts](../packages/engine/src/store.ts) | Keeps the current project and undo/redo history in memory |
| [src/operations.ts](../packages/engine/src/operations.ts) | Adds, moves, splits, trims and removes clips/tracks |
| [src/professional.ts](../packages/engine/src/professional.ts) | Handles slip, rolling trim, duplicate, locks, effects and keyframe edits |
| [src/timeline.ts](../packages/engine/src/timeline.ts) | Answers timeline questions, such as its duration |
| [src/project.ts](../packages/engine/src/project.ts) | Saves and loads the project and copied media |
| [src/validation.ts](../packages/engine/src/validation.ts) | Checks that project data is valid before it is accepted |
| [src/markers.ts](../packages/engine/src/markers.ts) | Adds and changes timeline notes |
| [src/titles.ts](../packages/engine/src/titles.ts) | Adds and changes titles |
| [src/captions.ts](../packages/engine/src/captions.ts) | Adds and changes subtitle lines and their times |
| [src/presets.ts](../packages/engine/src/presets.ts) | Saves, imports and applies reusable effect settings |

The project has one main store. The screen and AI both change this same store. They do not keep two separate editable timelines.

The saved project is `project.json` inside a `.freemier` project folder. It records editing decisions: which clips to use, their times, effects, titles and other settings. Copied-media projects also include media files. The exported video is a separate file you create with Export.

## 3. ffmpeg: video and audio work

FFmpeg is an external program that reads and makes media files. This folder tells it what work to do.

| File | What it does |
|---|---|
| [src/media.ts](../packages/ffmpeg/src/media.ts) | Reads media information, imports files, and makes thumbnails/waveforms |
| [src/export.ts](../packages/ffmpeg/src/export.ts) | Builds the final video/audio from the project |
| [src/effects.ts](../packages/ffmpeg/src/effects.ts) | Turns effect and animation settings into FFmpeg instructions |
| [src/text.ts](../packages/ffmpeg/src/text.ts) | Makes the title/subtitle images used by preview and export |
| [src/run.ts](../packages/ffmpeg/src/run.ts) | Starts FFmpeg/ffprobe and reads their results |
| [fonts/](../packages/ffmpeg/fonts/README.md) | Holds the bundled font and its license |

The GUI draws its live preview. This folder supplies media/text work and creates the final exported file.

## 4. mcp: the AI's remote control

MCP is a standard way for an AI tool to ask another program to do work. Here, it lets an AI ask the editor to import a file, cut a clip, add a title or export a video.

| File | What it does |
|---|---|
| [src/cli.ts](../packages/mcp/src/cli.ts) | Starts the MCP connection |
| [src/server.ts](../packages/mcp/src/server.ts) | Receives standard MCP requests and sends results |
| [src/tools.ts](../packages/mcp/src/tools.ts) | Defines the main editing commands and their inputs |
| [src/bridge.ts](../packages/mcp/src/bridge.ts) | Connects the screen to the same project and command handlers |
| [src/professional-tools.ts](../packages/mcp/src/professional-tools.ts) | Exposes effect, animation and additional editing commands |
| [src/marker-tools.ts](../packages/mcp/src/marker-tools.ts) | Exposes marker commands |
| [src/title-tools.ts](../packages/mcp/src/title-tools.ts) | Exposes title commands |
| [src/caption-tools.ts](../packages/mcp/src/caption-tools.ts) | Exposes subtitle commands |
| [src/preset-tools.ts](../packages/mcp/src/preset-tools.ts) | Exposes preset/import descriptions and commands |
| [src/media-cli.ts](../packages/mcp/src/media-cli.ts) | Provides the separate command-line media inspector |

## 5. shared: common information

The other folders must agree on what a clip, effect or title contains. This folder keeps those common definitions and calculations.

- [src/types.ts](../packages/shared/src/types.ts): the common project, clip, track and media fields.
- [src/effects.ts](../packages/shared/src/effects.ts) and [src/animation.ts](../packages/shared/src/animation.ts): effect controls and animation calculations.
- `markers.ts`, `text.ts`, `captions.ts` and `presets.ts`: common rules for these features.
- [src/srt.ts](../packages/shared/src/srt.ts) and [src/timecode.ts](../packages/shared/src/timecode.ts): subtitle file reading/writing and video time calculations.
- `errors.ts` and `ids.ts`: clear error results and unique names for project items.

Each code folder also has an `index.ts` where needed. It makes the folder's functions available to the other code folders.

## What src, test and dist mean

- **src:** the actual code we change. The GUI also has a `renderer` folder for its screen code.
- **test:** checks that the code does the expected job. Some checks read actual video pixels and sound; others open the real desktop app.
- **dist:** code generated by the build command so the app can run. Change the original source, then build again.
- **node_modules:** downloaded software libraries used by the project. `npm ci` creates this folder.

`.ts` files contain TypeScript: JavaScript with extra checks for mistakes. `.js`, `.mjs` and `.cjs` are JavaScript files used in different parts of the app and its helpers. `tsconfig` files tell the build how to check the TypeScript code. `package-lock.json` records the exact library versions used.

Generated files, sample media, local projects and local working notes are excluded from Git. Public product guides belong in `docs`.

## A simple example: cutting a clip

1. You press Cut in the GUI, or an AI sends the matching MCP command.
2. The command reaches the engine.
3. The engine checks the clip and splits it into two clips in the main project store.
4. The GUI receives the changed project and shows both clips.
5. Save writes these editing decisions to the project folder.
6. Export asks the FFmpeg code to make a video using these decisions.

Saving an edit and exporting a video are different jobs.

## Where to look when you want a change

| You want to change... | Start here |
|---|---|
| A button's color, spacing or size | `gui/renderer/app.css` |
| The screen layout or panels | `gui/renderer/index.html` and `app.js` |
| What happens when you click | `gui/renderer/app.js` |
| The rules for cutting/moving clips | `engine/src/operations.ts` |
| Effect settings or animation | `shared/src/effects.ts`, `shared/src/animation.ts`, `engine/src/professional.ts` |
| How the final video is rendered | `ffmpeg/src/export.ts` and `effects.ts` |
| What an AI can ask the editor to do | `mcp/src/tools.ts` and the feature's `*-tools.ts` file |
| What is saved in a project | `shared/src/types.ts`, `engine/src/project.ts` and `validation.ts` |
| How to check a feature | The relevant folder's `test` files; desktop checks are under `gui/test` |

A complete editing feature usually needs a rule in the engine, an MCP command, a GUI control and a check. If it changes the picture or sound, it also needs preview/export support. Adding a button alone does not finish the feature.

Some files, especially GUI `app.js` and MCP `tools.ts`, currently contain several features together. Titles, captions, markers and presets already have separate engine and MCP files. The guide describes the current code layout; it does not mean every planned feature is implemented.
