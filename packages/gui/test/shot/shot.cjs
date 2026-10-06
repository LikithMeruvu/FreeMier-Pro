// Kept as a portable compatibility entry point; the screenshot uses the real app.
const { spawn } = require('node:child_process');
const path = require('node:path');
const child=spawn(process.execPath,[path.resolve(__dirname,'../screenshot.mjs'),...process.argv.slice(2)],{
  stdio:'inherit',windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},
});
child.on('error',(error)=>{console.error(error);process.exitCode=1;});
child.on('exit',(code)=>{process.exitCode=code??1;});
