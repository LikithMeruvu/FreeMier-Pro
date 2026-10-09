# transitions

`operations.ts` creates, changes, reads and removes source-handle-aware video dissolves and independent linear audio crossfades. Shared calculations derive frame timing; project validation refuses edits that break authored transitions. GUI and MCP use these same engine operations.

The initial profile requires adjacent clips, sufficient source handles and static participant transforms without enabled clip fades. Video rates must match the sequence. Additional transition types and mixed-rate rendering remain planned.

See the [folder guide](../../../../FOLDER-STRUCTURE.md) and [current support](../../../../docs/STATUS.md).
