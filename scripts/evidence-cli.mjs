import { spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import {
    appendEvidenceFile, evidenceDirectory, evidenceFile, makeEvidenceDirectory, openEvidenceOutput, writeEvidenceFile
} from './evidence.ts';
async function inspect(directory) {
    for (const name of await readdir(directory).catch(error=>{
        if(error.code==='ENOENT')return [];
        throw error;
    })) {
        const path=`${directory}/${name}`;
        if((await lstat(path)).isDirectory())await inspect(evidenceDirectory(path,true));
        else evidenceFile(path);
    }
}
async function capture(path,command,args) {
    const output=await openEvidenceOutput(path);
    try {
        const child=spawn(command,args,{stdio:['ignore',output.fd,output.fd],detached:true});
        const signal=value=>{
            if(child.pid&&child.exitCode===null&&child.signalCode===null)process.kill(-child.pid,value);
        };
        const interrupt=()=>signal('SIGINT');
        const terminate=()=>signal('SIGTERM');
        process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
        try {
            process.exitCode=await new Promise((resolve,reject)=>{
                child.once('error',reject);child.once('exit',code=>resolve(code??1));
            });
        } finally {
            process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);
        }
    } finally { await output.close(); }
}
async function main() {
    const [value,mode,...args] = process.argv.slice(2);
    const directory = evidenceDirectory(value,true);
    if(mode==='--capture')return capture(evidenceFile(`${directory}/${args[0]}`),args[1],args.slice(2));
    if(mode==='--record'||mode==='--append') {
        const write=mode==='--record'?writeEvidenceFile:appendEvidenceFile;
        const lines=args.slice(1).map(value=>value.startsWith('cmdBase64=')
            ?'cmd='+Buffer.from(value.slice(10),'base64').toString('utf8'):value);
        await write(`${directory}/${args[0]}`,lines.join('\n')+'\n');return;
    }
    await inspect(directory);
    for (const file of [mode,...args].filter(Boolean)) evidenceFile(`${directory}/${file}`);
    await makeEvidenceDirectory(directory,{recursive:true});
    console.log(directory);
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
