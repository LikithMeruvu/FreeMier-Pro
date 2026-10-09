# Workspace settings

A workspace layout is how you arrange the editor's screen. It does not change the video. Open **Workspace settings** from the menu bar to change the layout or save a named one.

You can show or hide the Library, Source monitor, Inspector and Transitions panel. The Program monitor, timeline and settings button stay available. Hiding Source pauses its own playback; the Program video and sound keep playing. Transitions sit inside the Inspector, so hiding the Inspector also hides that panel while keeping its saved visibility choice.

The controls change Library and Inspector widths, the Source/Program split, timeline height, timeline zoom, snap, grid, browser tab and Edit/Color/Audio mode. Automatic timeline height follows the window size. Small windows clamp the displayed sizes without changing the saved values.

Save up to **24 named layouts**. Names contain up to **48 single-line display characters**, are trimmed and normalized, and cannot duplicate another name by changing letter case. Apply restores a saved layout. Delete removes that named record and keeps the current screen arrangement. Restore defaults keeps valid named layouts.

## MCP commands

| Command | Inputs and result |
| --- | --- |
| `workspace_settings_get` | Read the current layout, named layouts, settings revision and recovery state. |
| `workspace_settings_update` | Send a strict `patch` containing only the fields below. Panel flags merge with existing flags. |
| `workspace_settings_reset` | Restore the default layout; explicitly recover an invalid file with a backup. |
| `workspace_layout_list` | Read named layout IDs, names and saved values. |
| `workspace_layout_save` | Supply `name`; receive `layoutId` and the updated settings. |
| `workspace_layout_apply` | Supply `layoutId` to restore its saved values. |
| `workspace_layout_delete` | Supply `layoutId` to remove its record. |

Every result contains `workspaceSettings`. Mutations can supply `expectedSettingsRevision` to refuse a stale change. This is separate from the project's `revision`; preferences do not create a video edit or undo entry. Live GUI updates also work when the project revision stays the same.

| Patch field | Allowed values |
| --- | --- |
| `mode` | `edit`, `color`, `audio` |
| `browser` | `project`, `effects`, `presets`, `markers`, `titles`, `captions` |
| `panels` | Boolean `library`, `source`, `inspector`, `transitions` flags; a partial object is allowed. |
| `libraryWidth` | Whole pixels from 180 to 420 |
| `inspectorWidth` | Whole pixels from 220 to 520 |
| `timelineHeight` | Whole pixels from 180 to 560, or `null` for automatic sizing |
| `sourceRatio` | Source share from 0.2 to 0.8 |
| `timelineZoom` | Finite pixels per second from 20 to 300; fractional fit values are allowed. |
| `snap`, `grid` | Booleans |

Example: `workspace_settings_update` with `{"patch":{"panels":{"source":false},"timelineZoom":72.5}}` hides Source and sets zoom without altering other settings or the project.

## Saving and recovery

The owning service stores these preferences in its workspace's `settings/workspace.json`. Opening, saving or undoing a video project leaves this file alone. Closing and restarting the owning editor restores the current layout and named IDs.

Writes use an exclusive temporary file in the same directory and publish it before reporting success. Failed writes keep the previous settings. Invalid JSON, unsupported versions or invalid values preserve the original file and show a read-only warning. **Restore defaults** makes an exclusive recovery copy before replacing that file. A failed backup refuses recovery.

The arrangement uses fixed panel positions with visibility and size controls. Floating panels, arbitrary CSS or scripts, vendor workspace imports, themes and custom keyboard mappings are not supported. Separate processes writing the same preferences file are not coordinated; these guarantees apply to the single owning session, and do not claim protection against every power failure.

Code ownership: [shared fields and validation](../packages/shared/src/workspace/settings.ts), [saving service](../packages/service/src/settings/workspace.ts), [described commands](../packages/service/src/commands/workspace.ts) and [visible controls](../packages/gui/src/panels/settings/settings.js). Windows checks and [Linux CI on the exact implementation](https://github.com/LikithMeruvu/FreeMier-Pro/actions/runs/37952642166) pass the build, 377 tests and all seven desktop suites. Detailed acceptance is in the [completion tracker](FEATURE-COMPLETION.md).
