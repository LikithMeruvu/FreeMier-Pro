# A simple code guide

The complete maintained map is [FOLDER-STRUCTURE.md](../FOLDER-STRUCTURE.md). It explains each file's job and marks folders reserved for unfinished features.

| Folder | Its job |
|---|---|
| packages/gui | The Electron window and visible editing panels |
| packages/engine | The rules that cut, move and change the project |
| packages/media | Read video/audio, make thumbnails, render text and export video |
| packages/service | Connect requests to one editing session and one project store |
| packages/mcp | Let any standard MCP client request those edits |
| packages/shared | Common project fields, calculations and error messages |
| assets | Bundled resources and licences |
| docs | Instructions; these explain the code but do not perform edits |

When you press Cut, the GUI sends a command to the service. The engine checks the clip and splits it in the main store. The GUI receives the new project and draws it. AI can request the same cut through MCP.

Save writes the editing project to disk. Export asks the media code and FFmpeg to turn those decisions into a finished video. These are separate jobs.

Presets currently live inside the project and its saved project.json. The planned personal library will store reusable user resources outside the code repository. The [folder map](../FOLDER-STRUCTURE.md#where-presets-and-imported-resources-go) explains both.

src holds source code. test holds checks. dist contains generated runnable code; edit source and build again. Folder names show responsibility, not proof that a planned feature works. See [current support](STATUS.md).
