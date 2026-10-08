# Project media organisation

The Project panel and MCP commands use the same media library inside the owning project. Bins group imported assets without moving source files. Each asset can have a display name, description, tags and rating. These fields are saved in `project.json`, support undo, and do not modify source-file metadata.

The Project panel offers ordinary nested bins, assignment of selected assets, search, kind filters, sorting and pages of results. Search matches names, descriptions and tags. Selecting a parent bin includes its descendants; selecting Root includes the whole hierarchy. All Media includes every imported asset. Source playback and timeline placement still use the selected asset.

## MCP commands

| Command | Purpose |
| --- | --- |
| `media_bins` | List bins; the implicit project root has ID `null`. |
| `media_bin_create` | Create a bin under the root or another bin. |
| `media_bin_update` | Rename or move a bin; refuse duplicate sibling names and cycles. |
| `media_bin_delete` | Remove an empty bin; refuse child bins or assigned assets. |
| `media_assign_bin` | Assign one or more assets in one undoable edit. |
| `media_metadata_update` | Change a display name, description, tags or rating. |
| `media_query` | Search/filter/sort with `limit` and `offset`; return the total and observed revision. |
| `media_availability` | Check paths and optionally verify saved file identity, without editing history. |
| `find_relink_candidates` | Search user-specified folders within declared limits; return matches without choosing one. |
| `media_relink` | Verify and explicitly replace one asset location, preserving its timeline references. |

`media_import` also accepts an optional `binId`. Import and bin assignment are one project edit. Mutating library commands accept an optional `expectedRevision`; relink and import also refuse any project edit or undo that occurs while their file checks run. Refresh and retry after a refusal. Use `tools/list` for exact input descriptions.

## Missing files and relinking

New imports save a streaming SHA-256 content identity and byte count. A normal availability check inspects path existence, file type and size; matching size alone is **unverified**. Select Verify files or pass `verify: true` to read and check the actual bytes, including content-access failures. Results are observations at the time of checking, not permanent promises that a file cannot change later.

Candidate discovery searches only explicitly supplied directories. Defaults are depth 3, 500 visited entries and 128 MiB of candidate hash bytes. Maximum settings are 8 roots, depth 8, 2,000 entries and 1 GiB; at most 64 candidates are returned. Discovery skips symbolic links and reports truncation. A candidate's matching name or size does not establish identity. Multiple exact matches require a user's or agent's explicit choice.

Relink checks identity and media properties before switching one asset's path. Clips, linked sound/picture, timing, effects and keyframes keep their identities. Referenced media uses the replacement path. Copied media gets a fresh exclusive workspace copy; old bytes remain for undo. Failed operations remove only copies they created and never delete existing media.

Older projects without a saved identity remain supported. Their replacement requires `acceptUnverified: true` or the visible consent checkbox, plus compatible probed properties and source ranges. This cannot bypass a known identity mismatch. Saving a copied-media project packages its current media; reopening uses those packaged files.

## Limits

The current profile supports 256 bins, depth 32, names up to 120 characters, descriptions up to 4,096 characters, 32 tags of up to 64 characters and integer ratings from 0 to 5. Queries return up to 1,000 rows per call. File checks can take time on large media; cancellable background jobs are a separate planned feature.

Saved search bins, external media indexes, source-file XMP edits, proxies and visual AI search are not implemented. Project bins are separate from the planned personal library shared across projects. Format decoding still depends on installed FFmpeg/ffprobe. See [current support](STATUS.md) and the [27-area tracker](FEATURE-COMPLETION.md).
