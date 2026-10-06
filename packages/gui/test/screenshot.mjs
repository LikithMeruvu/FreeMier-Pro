import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Capture the production Electron app after actual MCP edits and media decode.
const child=spawn(process.execPath,[fileURLToPath(new URL('./live-sync.mjs',import.meta.url)),'--screenshot-only',...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});
child.on('error',(error)=>{console.error(error);process.exitCode=1;});
child.on('exit',(code)=>{process.exitCode=code??1;});
