// Independent terminal fixture: controlled shutdown, no account or model use.
import {existsSync,writeFileSync} from 'node:fs';
const marker=process.argv[2];
process.on('SIGTERM',()=>writeFileSync(marker+'.terminal-stopping','stopping'));
writeFileSync(marker+'.terminal-ready','ready');
setInterval(()=>{if(!existsSync(marker+'.terminal-ready'))process.exit(0);if(existsSync(marker+'.terminal-release')){
  process.stdout.write('last output before real terminal close\n',()=>process.exit(0));
}},5);
