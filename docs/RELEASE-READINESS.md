# Release readiness

FreeMier Pro currently offers a public **developer source preview**. It is not yet a production-ready desktop editor. The [verified status](STATUS.md) records bounded engine, standard MCP, native Electron and decoded-render checks. A passing test suite establishes those cases, not compatibility with every camera, codec, machine or editing workload.

## Release levels

| Level | Gate | Current status |
|---|---|---|
| Source preview | Document dependencies and limitations; published commit passes build, headless tests and native acceptance | Public repository available; new milestones require verification on their exact commit |
| Downloadable desktop alpha | Package application and MCP entry point; verify fonts/native dependencies outside the checkout; test installation on clean Windows/Linux systems; basic save/recovery/export and bridge protections | Not complete |
| Production release | Supported-format and real-footage trials, recovery and safe overwrite/cancel behavior, sustained performance and installed MCP/GUI interoperability pass for a declared supported scope | Not complete |

There is no confirmed release date yet. An alpha can advertise a smaller CPU editing scope without waiting for every advanced feature. Production readiness requires a reliable application within its stated supported scope.

## Open release gates

- **Installation:** the current launch path uses a checkout, Node/npm and externally installed FFmpeg/ffprobe. No installer or packaged-artifact acceptance exists yet. Development Electron and its standalone font test do not establish installed-application behavior. [Electron's packaging guide](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging) describes the additional distributable tooling.
- **Data protection:** project JSON saves use a temporary file and rename. [Structural schema-1 validation](PROJECT-FORMAT.md) now guards the owning store, persistence and native export boundaries, with corrupt-input refusal verified through stdio and actual Electron Open on Windows/Linux. Dirty-close protection, autosave/recovery, media integrity validation and protected export publication remain required. Export currently writes directly to its destination; export cancellation/recovery is not implemented.
- **Shared-session identity:** the loopback bridge needs strict workspace identity, session authentication and request validation before a downloadable alpha. Current checks restrict peer/origin but do not establish full session isolation. This is a hardening gap, not a demonstrated exploit.
- **Desktop boundaries:** context isolation, disabled renderer Node integration and CSP are present. Sender validation for privileged IPC and restrictions on navigation/new windows remain required. [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security) supplies the reference controls.
- **Native media setup:** probe actual available encoders, filters and font support; report missing capabilities before a render. Bundled FFmpeg, if added, needs its exact build/license/source notices. The application's MIT license does not cover every dependency. See [FFmpeg's licensing documentation](https://ffmpeg.org/legal.html) and the bundled font's [OFL notice](../assets/fonts/README.md).
- **Compatibility and performance:** synthetic decoded tests and native controls are verified. Phone variable-frame-rate/rotation, mixed-rate footage, high-resolution/long edits, missing media, interruption and physical audio playback need separate evidence. Unsupported profiles must remain explicit.

## Optional real-footage acceptance

Use this procedure when evaluating the editor with footage you own.

1. Use copies of self-recorded SDR H.264/AAC constant-rate 1080p/30 video, a WAV and a still. Begin with a 30–60 second edit; include filenames with spaces.
2. Make Source in/out ranges and three cuts. Exercise trim/slip/roll/duplicate/razor, lock refusal and undo before adding animation/fades. Place sound explicitly on audio tracks while linked AV remains pending.
3. Add markers, titles and supported SRT captions. Alternate GUI and standard MCP commands and confirm one owning project state.
4. Save copied media, reopen, move the entire project directory and make original media unavailable. Confirm restored preview/export and unchanged source hashes.
5. Export the supported format, fully decode and probe dimensions/frame rate/duration/audio, then watch and listen end to end. Check synchronization at the beginning, middle and end and duration within one output frame.
6. Record the source commit, platform, native runtime, source profiles and failures locally. Keep personal footage, credentials and machine paths out of public commits.

Follow with separate VFR/rotation, HEVC, 4K/60 and long-form trials. A stable release requires reproducible results across the advertised profiles and clean installed applications, rather than a claim of exhaustive editor parity.
