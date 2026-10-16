import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';

if (process.env.AUCTION_TEST_FAIL_ADMIN === '1') {
    const spawn = childProcess.spawn;
    childProcess.spawn = function(command, args, options) {
        if (args?.includes('run') && args.includes('admin:managers')) {
            throw new Error('Injected post-acquisition setup failure');
        }
        return spawn.call(this, command, args, options);
    };
    syncBuiltinESMExports();
}

if (process.env.AUCTION_TEST_FAIL_BROWSER === '1') {
    const execFile=childProcess.execFile;
    childProcess.execFile=function(command,args,...rest) {
        if(command==='agent-browser'&&!['open','close','session'].some(value=>args?.includes(value))) {
            throw new Error('Injected browser setup failure');
        }
        return execFile.call(this,command,args,...rest);
    };
    childProcess.execFile[promisify.custom]=(...args)=>new Promise((resolve,reject)=>{
        childProcess.execFile(...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));
    });
    syncBuiltinESMExports();
}
