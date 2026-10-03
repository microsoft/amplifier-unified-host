// Public installed-host crash fixture. All paths come from the test's fresh private temporary root.
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
const {createHost,StdioCatalog}=await import(process.env.HOST_PACKAGE?pathToFileURL(process.env.HOST_PACKAGE).href:new URL('../dist/index.js',import.meta.url).href);
const catalog=new StdioCatalog({command:input.python,args:['-I',fileURLToPath(new URL('./catalog-no-history.py',import.meta.url)),'serve','--db',input.index,'--home',input.home,'--scan-interval','0','--workspace-check-interval','0']});
let calls=0;const project=catalog.projectSessionVisibility.bind(catalog);
catalog.projectSessionVisibility=async request=>{calls++;if(calls===input.killAt&&!input.after)process.kill(process.pid,'SIGKILL');const result=await project(request);if(calls===input.killAt&&input.after)process.kill(process.pid,'SIGKILL');return result;};
const host=await createHost({stateDirectory:input.stateDirectory,allowedWorkspaceRoots:[input.workspace],catalog,engines:[{id:'amplifier',command:'/must-not-start-during-crash-repair'}],conversationPresentation:{}});
await host.applyConversationPresentation({commandId:'killed-reset',reviewId:input.review.reviewId,reviewHash:input.review.reviewHash},input.actor);
throw Error('Crash point was not reached');
