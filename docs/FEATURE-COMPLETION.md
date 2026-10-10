# Feature completion tracker

This tracker follows the same 27 product areas throughout development. Development state and final acceptance are tracked separately. Existing basic functions do not mean a broader area is complete. Planned folders and reserved ownership do not count as implemented work.

## Status rules

- **Development:** Not started, In development, or Implemented. Implemented means the scoped behavior exists; it does not mean it has passed final acceptance.
- **Acceptance:** Not accepted or Accepted. An area is accepted only when its relevant engine and shared service behavior, standard MCP calls, actual GUI behavior, and real media preview/export or project persistence checks pass. Platform, hardware, and installation checks also apply where listed in the remaining-work criterion.
- **Done** means development is Implemented and acceptance is Accepted. Do not infer acceptance from legacy checks or from a narrower existing capability.
- Record reviewable checks in the acceptance evidence section before marking an area accepted.

## Current summary — 10 October 2026

| Measure | Count |
| --- | ---: |
| Done | 5 / 27 |
| Incomplete | 22 / 27 |
| In development | 0 |
| Not started | 21 |
| Implemented, waiting for acceptance | 1 |
| Without final acceptance | 22 |

The current suite passes 413 tests in 34 files, the 40 baseline Electron checks, the standalone font check, the project/track suite, 10 linked-media checks and the media organisation, transition, workspace-settings and project-protection Electron workflows on Windows. Project protection is implemented and Windows-verified; its exact-commit Linux CI runs on publication. The preceding workspace-settings milestone passed [Linux CI on its implementation](https://github.com/LikithMeruvu/FreeMier-Pro/actions/runs/37952642166). Existing regression checks do not establish acceptance for the other 21 areas.

## Fixed area tracker

| ID | Area | Development | Acceptance | Remaining work |
| ---: | --- | --- | --- | --- |
| 1 | Transitions | Implemented | Accepted | Adjacent same-track video dissolve and linear audio crossfade verified through engine/MCP, visible controls, locks/undo, portable reopen and decoded preview/export. Video rates must match the sequence; keyframed/fading participants, mixed/variable-rate dissolves, wipes and plugins remain unsupported extensions. See [limits](TRANSITIONS.md). |
| 2 | Linked video/audio | Implemented | Accepted | Aligned one-video/one-audio profile verified: paired placement, link/unlink, atomic timing edits/undo, GUI controls, save/reopen, audible preview and decoded export. Offset/multiple-audio groups and non-mirrored ripple remain unsupported extensions. |
| 3 | Multiple timelines | Not started | Not accepted | Create, name, switch, edit, save, and reopen multiple timelines in one project through engine, MCP, and GUI. |
| 4 | Multicam | Not started | Not accepted | Sync and switch among camera angles, preserve edits, and verify the resulting preview and export. |
| 5 | Speed editing | Not started | Not accepted | Support variable and constant clip speed with correct timing, sound behavior, preview, and export. |
| 6 | Advanced compositing | Not started | Not accepted | Provide layered compositing controls and verify the rendered result in preview and export. |
| 7 | Advanced colour | Not started | Not accepted | Provide focused color tools and verify color changes in actual preview and exported media. |
| 8 | Advanced audio | Not started | Not accepted | Provide track and clip processing, mixing and automation controls with audible preview and rendered audio checks. |
| 9 | Animated text | Not started | Not accepted | Create and edit timed text animation and verify it in actual preview and export. |
| 10 | Advanced captions | Not started | Not accepted | Support caption authoring and import/export formats, timing and styling, then verify persisted captions and rendered output. |
| 11 | AI features | Not started | Not accepted | Deliver and verify the planned AI workflows as a whole: speech transcription, caption generation, media search/understanding, and editing assistance; include local use, optional user-provided API keys, CPU fallback, and GPU support where applicable. A single provider or workflow is insufficient. |
| 12 | Personal library | Not started | Not accepted | Build a reusable asset library with metadata, organization, project reuse, persistence, GUI access, and MCP operations. |
| 13 | Broader imports | Not started | Not accepted | Support named import groups: vendor presets, LUTs, animated templates, graphics, transition assets, and project interchange. Publish an explicit supported-format matrix and verify representative supported files import, edit, save, preview, and export. Do not imply support for every vendor format. |
| 14 | Native plugins | Not started | Not accepted | Define and implement a usable native plugin interface, loading and failure handling, GUI/MCP availability, and platform compatibility checks. |
| 15 | Media organisation | Implemented | Accepted | Ordinary nested bins, metadata, search/filter/sort/paging, file availability and explicit verified relink pass shared engine/service, standard MCP, GUI, undo/save/reopen and decoded output checks on Windows/Linux. Saved search bins, XMP writes, proxies and external indexes remain unsupported extensions. |
| 16 | Native preview | Not started | Not accepted | Provide responsive decoded video and audio playback, seeking and synchronization in the desktop GUI, verified on supported platforms. |
| 17 | GPU processing | Not started | Not accepted | Accelerate supported processing on compatible hardware, detect capability, fall back to CPU, and verify output correctness and runtime behavior on GPU and CPU. |
| 18 | More editing tools | Not started | Not accepted | Deliver the planned additional editing operations through engine, MCP, and GUI, with undo/persistence and real output checks for each supported operation. |
| 19 | More MCP controls | Not started | Not accepted | Expose the full supported editing and project-control surface through standard MCP tools, with documented inputs/results and client-call verification. |
| 20 | Background jobs | Not started | Not accepted | Run long media work as observable cancellable jobs with progress, completion/failure reporting, and verified outputs. |
| 21 | Scopes | Not started | Not accepted | Provide relevant video and audio scopes that update from the actual project signal and remain consistent with preview/export. |
| 22 | Workspace settings | Implemented | Accepted | Windows/Linux checks pass for persistent preferences and named layouts, visible panel sizes/visibility, independent project history, service reconnect, app restart and backed-up settings recovery. Floating panels, vendor layout import and custom keyboard mappings are unsupported extensions. See [support](WORKSPACE-SETTINGS.md). |
| 23 | Missing GUI controls | Implemented | Accepted | Visible New Project/settings and track rename/reorder/remove verified with refusal, undo and persistence. FPS changes on authored timelines are explicitly refused until conversion exists. |
| 24 | Project protection | Implemented | Not accepted | Autosave, content-based saved state, immutable verified recovery versions, guarded replacement and unsaved-close protection pass shared engine/service, standard MCP, actual GUI, decode and real Save/reopen/failure scenarios on Windows; exact-commit Linux CI runs on publication. Forced termination cannot prompt; cloud backup and cross-process writer locking remain unsupported extensions. See [project protection](PROJECT-PROTECTION.md). |
| 25 | Safe export | Not started | Not accepted | Protect existing outputs from accidental overwrite, export through temporary output with safe publication, and handle cancellation or interruption with safe recovery. Verify playable output, failure handling, and source-project integrity. |
| 26 | Desktop delivery | Not started | Not accepted | Produce and verify installable Windows and Linux releases, including launch, required media/runtime dependencies, and clean-machine installation/update checks. |
| 27 | Session protection | Not started | Not accepted | Enforce owning workspace/session identity and authentication; validate bridge requests, check privileged IPC senders, restrict navigation, and test refusal of cross-session access. |

## Acceptance evidence

Record concise evidence here when an area reaches final acceptance: date, platform/configuration where relevant, and links or commands/results for engine/service, standard MCP, actual GUI, and real media or persistence checks. Keep evidence specific to the row and its remaining-work criteria.

| ID | Evidence |
| ---: | --- |
| 22 | Windows/Linux, 9 October: three [shared contract tests](../packages/shared/test/workspace/settings.test.ts), 16 [service persistence tests](../packages/service/test/settings/workspace.test.ts) and five [standard SDK cases](../packages/mcp/test/stdio/workspace-settings.test.ts) verify strict validation, serialized atomic writes, stale/no-op refusal, independent history, restart, and preservation/backup of invalid settings. [Actual Electron](../packages/gui/test/acceptance/workspace-settings.mjs) verifies visible layout controls and named CRUD, mandatory panel access, responsive sizing, fractional zoom, remote updates without a project edit, live reconnect, cold restart, recovery backups and unchanged decoded preview/export. Build, all 377 tests and all seven desktop suites pass on Windows and in [exact implementation Linux CI](https://github.com/LikithMeruvu/FreeMier-Pro/actions/runs/37952642166). Seven commands append to the preceding 87 unchanged input schemas. |
| 1 | Windows and Linux, 9 October: [shared frame/alpha checks](../packages/shared/test/calculations/transitions.test.ts), [engine ownership/persistence checks](../packages/engine/test/transitions/transitions.test.ts), 18 [native decoded cases](../packages/media/test/transitions/transitions.test.ts) and three [standard SDK MCP cases](../packages/mcp/test/stdio/transitions.test.ts) verify all alignments, odd frames, real handles, complementary sound, unequal-alpha layers, static rotation/track order and refusal of missing/delayed/off-grid streams. [Actual Electron](../packages/gui/test/acceptance/transitions.mjs) verifies visible add/update/remove/undo, marker intervals, locks, audible playback, decoded preview/export and reopening a portable project with reversed clip arrays. Full build, all 353 tests and all desktop suites passed; 87 tools retain the preceding 82 input schemas. Build, all tests and desktop acceptance also passed [Linux CI on the verified repair commit](https://github.com/LikithMeruvu/FreeMier-Pro/actions/runs/37946475018). |
| 2 | Windows, 8 October: 32 [engine cases](../packages/engine/test/linked-media/linked-media.test.ts); [standard SDK stdio tests](../packages/mcp/test/stdio/linked-media.test.ts) fully decode exported frames/samples, check source-window timing/silent gaps/level and reopen copied media; [actual Electron suite](../packages/gui/test/acceptance/linked-media.mjs) passes 10 checks covering source/drop placement, linked selection, all paired timing controls, chooser/cancel, locks, undo, decoded audible preview, save/open and export. |
| 23 | Windows, 8 October: four [engine cases](../packages/engine/test/project/settings.test.ts), including equal-order locked-layer preservation; standard MCP settings/reorder and decoded output-dimension checks; [actual Electron suite](../packages/gui/test/acceptance/project-tracks.mjs) verifies creation/settings, preserved content, fps refusal, undo, save/reopen, visible reorder/rename/remove, locks and authored-track restoration. Only native confirmation/prompt replies are substituted in this headless test. |
| 15 | Windows and [Linux CI](https://github.com/LikithMeruvu/FreeMier-Pro/actions/runs/37812909590), 8 October: 38 [engine cases](../packages/engine/test/library/organisation.test.ts); [file identity checks](../packages/media/test/identity/source.test.ts) and [failed-import checks](../packages/media/test/identity/import-failure.test.ts); 11 [native service cases](../packages/service/test/library/relink.test.ts) cover refusals, concurrent edits/undo, retained copies, external replacements and cache recovery; three [standard SDK MCP cases](../packages/mcp/test/stdio/media-organisation.test.ts) check discovery, bins/query/history, multiple exact candidates and fully decoded linked picture/sound after relink and portable reopen; [actual Electron workflow](../packages/gui/test/acceptance/media-organisation.mjs) operates bins/import/filter/sort/metadata/save/open/offline/relink, checks delayed thumbnails across edits, and decodes source/export. The exact implementation commit passed Linux build, tests and real Electron/Xvfb acceptance. |
