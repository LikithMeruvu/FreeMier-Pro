# FreeMier Pro

Build an independent, open-source, MCP-first video editor for Windows and Linux. All editing capabilities must be callable by any standard MCP client and reflected in the live GUI.

Use a source/program editing workspace with focused color and audio panels. Prefer local models with optional bring-your-own API keys and GPU acceleration with a working CPU fallback.

Plan changes before editing. Preserve the headless engine and single owning project store. Distinguish implemented features from planned work. Keep private working notes in ignored local folders; publish product documentation and the development roadmap. Do not publish internal execution notes.

Keep native media operations behind FFmpeg argument arrays. No proprietary source/resources, personal workspace files, credentials or machine-specific configuration belong in commits. Retain the existing project-format compatibility when extending its schema. Add meaningful engine/export/runtime verification for new behavior.

Keep FOLDER-STRUCTURE.md current in the same change whenever a folder, file location, feature owner or storage location changes. Keep features in their named folders, with tests under the matching package. Reserved folders document planned ownership; they are not implemented features. GUI panels and MCP adapters must call the shared service and engine rather than maintaining another editable project store. Run npm run check:structure after structural changes.
