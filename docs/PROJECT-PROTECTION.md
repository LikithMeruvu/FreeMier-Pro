# Project protection

This area is implemented and accepted: engine, service, standard-MCP and actual-Electron checks pass on Windows, including real Save/failure/crash/close scenarios, and the exact implementation commit passed [Linux CI](https://github.com/LikithMeruvu/FreeMier-Pro/actions/runs/38068512122) with all 413 tests and all eight desktop suites. See the [completion tracker](FEATURE-COMPLETION.md).

The editor compares the current project with the content that actually finished saving. Undoing back to that content clears the unsaved flag. Saving while an agent makes another edit saves the captured version; the newer edit stays unsaved. A new unchanged project has no saved file until you choose Save.

## Recovery versions

Automatic recovery defaults to every 60 seconds while there are unsaved changes, retaining ten completed versions per project. Configure the interval from 10 to 3,600 seconds and retention from one to 50. **Save recovery now** makes a version without overwriting your normal project or marking edits saved.

Each completed version contains its project document and verified copies of media marked as copied. External footage stays an external reference: inspection reports available, changed, missing or unverified files. Recovered projects use their own copied media folder. Recovery copies can take time and disk space, particularly with large footage; this is not a measured performance guarantee.

Inspect a listed version before choosing Restore. Dirty work requires a Save, Discard or Cancel choice. Restored work remains unsaved until normal Save. Recovery does not overwrite the original saved project. Interrupted staging directories and damaged packages are not offered as valid completed versions. Deleting a version removes its own package, not source footage or normal project files.

## MCP commands

| Command | Purpose |
| --- | --- |
| `project_protection_get` | Read dirty state, saved path, token, autosave settings and recovery errors. |
| `project_protection_configure` | Merge an `enabled`, `intervalSeconds` or `retention` patch. Invalid configuration needs explicit `resetInvalid:true`, preserving a backup. |
| `project_recovery_create` | Create a completed version and return its opaque ID. |
| `project_recovery_list` | List completed validated versions. |
| `project_recovery_inspect` | Check a `recoveryId` and its media availability. |
| `project_recovery_restore` | Restore a `recoveryId` using the exact current `expectedProtectionToken`; dirty work also requires `discardUnsaved:true`. |
| `project_recovery_delete` | Delete one recognized owned version using its `recoveryId`. |
| `project_replace` | Guarded `action:"create"` or `action:"load"`, with the current token and explicit dirty discard consent. Load requires `path`; create accepts project settings. |

Use `project_replace` for guarded New/Open. For compatibility, legacy `project_create` and `project_load` retain their explicitly destructive replacement behavior and bypass the unsaved-work guard. This difference is also reported by `editor_capabilities`.

`project_save` returns `savedTo`, `savedToken` and `projectProtection`. `savedTo` names the published `project.json`; supply its parent project directory when saving there again. A successful response with `dirty:true` means the captured version was saved and later edits still need saving. Protection tokens are separate from project revisions and never rewind with Undo.

## Closing and storage

Standalone close offers Save, Discard and Cancel for unsaved work. Failed saves, canceled paths and edits made during the close/save decision keep the window open. A GUI viewing an external MCP session can close without ending that owning session; its project remains with the MCP process.

Autosave settings live in the owning workspace's `settings/project-protection.json`. Versions live in `recovery/<version ID>/` with `project.json`, `manifest.json` and `media/`. These user files stay outside Git. Normal saved `.freemier` and legacy `.palmier` project documents retain their existing format.

Forced termination cannot display a close prompt. Recovery covers completed versions, not an unfinished write or every possible power failure. Cloud backup and separate-process writer locking are unsupported.

Code: [saved-content tracker](../packages/engine/src/recovery/protection.ts), [recovery storage](../packages/service/src/recovery/protection.ts), [described commands](../packages/service/src/commands/protection.ts), [visible controls](../packages/gui/src/panels/recovery/protection.js). Verification uses [engine tests](../packages/engine/test/recovery/protection.test.ts), [native service tests](../packages/service/test/recovery/protection.test.ts), [standard MCP](../packages/mcp/test/stdio/project-protection.test.ts) and [actual Electron](../packages/gui/test/acceptance/project-protection.mjs).
