# Portable effect presets

A preset saves a group of effect settings so you can reuse it on another clip. FreeMier Pro currently supports its own `.fmfx.json` format for the seven built-in effects. Wider format support is planned.

## File format

```json
{
  "format": "freemier-effect-preset",
  "version": 1,
  "name": "Warm look",
  "description": "A gentle sepia tint for a video clip.",
  "author": "Example author",
  "tags": ["warm", "video"],
  "media": "video",
  "effects": [
    { "type": "sepia", "enabled": true, "params": { "amount": 0.3 } }
  ]
}
```

All top-level fields shown above are required. `media` is `video` or `audio`; every effect must match it. `effects` is an ordered list of `{type, enabled, params}`. Unknown fields, effects, versions and invalid values are rejected. Missing supported effect parameters receive the same defaults as direct effect editing.

Supported effect types are `color_adjust`, `grayscale`, `sepia`, `blur`, `sharpen`, `video_fade` and `audio_fade`. Use `effect_catalog` to discover each effect's description, controls, defaults, limits and preview behavior.

## Limits and saved library

- Each input is at most 64 KiB and contains 1–32 effects of one media kind.
- A project library holds at most 64 presets.
- Names and authors allow up to 128 characters; descriptions allow up to 4096. Up to 16 unique tags are allowed, each with at most 64 characters.
- A hash of normalized content identifies duplicates. Whitespace and object-key order do not create a new preset; descriptions and effect order are part of its identity.
- The optional `effectPresets` field saves the library inside schema-1 projects. Older projects without it remain supported.
- Descriptions are supplied by the preset author and shown as text. They are not executable instructions.

## MCP commands

| Command | Purpose |
|---|---|
| `effect_preset_inspect` | Check supplied JSON or a local file without importing it |
| `effect_preset_import` | Add a validated preset to the project library |
| `effect_preset_list` | Search names, descriptions, authors and tags |
| `effect_preset_get` | Read a preset's description, settings, control schemas and compatibility limits |
| `effect_preset_capture` | Create portable JSON from a clip's effect stack and supplied metadata |
| `effect_preset_export` | Return JSON or create a new local file; existing files are not overwritten |
| `effect_preset_apply` | Append to or replace a matching clip's effect stack in one undo step |
| `effect_preset_remove` | Remove a library entry; already-applied effects remain on their clips |
| `import_capabilities` | List the currently implemented import handlers and their limits |

Inspection/import accepts exactly one of `content` or `path`. File input must be a bounded UTF-8 regular file. Tool responses include descriptions, effect settings, available controls, media kind, dependencies and preview/export limits. Discover current argument schemas through standard MCP `tools/list`.

The GUI's Presets tab uses the same commands. It supports file import/export, pasted JSON, capture from a clip, description search and append/replace application.

Applying a preset validates the full stack before changing the project. A locked track, wrong media kind, too many effects or fades beyond the clip cause a refusal. Fade times are clip-local seconds and are not stretched to a new clip's duration. Applied effects receive fresh identities and remain independent of the library.

Presets contain effect settings. They do not include source media, transform animation, fonts, scripts or external plugin binaries. CPU export uses the built-in FFmpeg effect path; spatial preview limitations remain visible in effect descriptions. Native vendor preset/template formats are currently unsupported.
