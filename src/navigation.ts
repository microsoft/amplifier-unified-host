import type {DatabaseSync} from 'node:sqlite';

export interface NavigationProjection {version:1;activityAt:number;agentCreated:boolean;}
type Creation={creatorSessionId:string;requestId:string};
type Post={id:string;at:number};
interface Position {version:1;base:number;raw:number;posts:Post[];creation?:Creation;}
const stamp=(n:number)=>{if(!Number.isFinite(n)||n<0)throw Error('Invalid navigation timestamp');return n;};
export function checkedCreation(value:Creation):Creation {
 if(!value||Object.keys(value).sort().join(',')!=='creatorSessionId,requestId'||Object.values(value).some(v=>typeof v!=='string'||!v||v.length>512))throw Error('Invalid trusted creation provenance');
 return {creatorSessionId:value.creatorSessionId,requestId:value.requestId};
}

/** A bounded presentation projection, never an execution or retry authority.
 * Its additive column is ignored by older Host versions during rollback. */
export class NavigationIndex {
 constructor(private db:DatabaseSync){}
 private read(uri:string,seed:number):Position {
  const row=this.db.prepare('SELECT navigation FROM session_admission WHERE uri=?').get(uri);
  if(!row?.navigation)return {version:1,base:stamp(seed),raw:seed,posts:[]};
  const value=JSON.parse(String(row.navigation)) as Position;
  if(value.version!==1||!Array.isArray(value.posts)||value.posts.length>16)throw Error('Invalid retained navigation projection');
  stamp(value.base);stamp(value.raw);
  for(const post of value.posts){if(typeof post.id!=='string'||!post.id||post.id.length>512)throw Error('Invalid navigation input identity');stamp(post.at);}
  if(value.creation!==undefined)checkedCreation(value.creation);
  return value;
 }
 private write(uri:string,value:Position){this.db.prepare('INSERT INTO session_admission(uri,navigation) VALUES(?,?) ON CONFLICT(uri) DO UPDATE SET navigation=excluded.navigation').run(uri,JSON.stringify(value));}
 initialize(uri:string,seed:number){const value:Position={version:1,base:stamp(seed),raw:seed,posts:[]};this.db.prepare('INSERT INTO session_admission(uri,navigation) VALUES(?,?) ON CONFLICT(uri) DO UPDATE SET navigation=excluded.navigation WHERE session_admission.navigation IS NULL').run(uri,JSON.stringify(value));}
 projection(uri:string,seed:number):NavigationProjection {const p=this.read(uri,seed);return {version:1,activityAt:Math.max(p.base,...p.posts.map(post=>post.at)),agentCreated:!!p.creation};}
 post(uri:string,id:string,at:number,seed:number){
  if(!id||id.length>512)throw Error('Invalid navigation input identity');
  const p=this.read(uri,seed);if(p.posts.some(post=>post.id===id))return;
  if(p.posts.length===16)throw Error('Unsettled navigation admission capacity reached');
  p.posts.push({id,at:Math.max(stamp(at),p.raw,p.base,...p.posts.map(post=>post.at))});this.write(uri,p);
 }
 disposition(uri:string,id:string,result:'accepted'|'retained'|'rejected',seed:number){
  const p=this.read(uri,seed),index=p.posts.findIndex(post=>post.id===id);if(index<0)return;
  if(result==='rejected')p.posts.splice(index,1);
  else{p.base=Math.max(p.base,...p.posts.slice(0,index+1).map(post=>post.at));p.posts=p.posts.slice(index+1);}
  this.write(uri,p);
 }
 progress(uri:string,at:number,seed:number,settled=false){
  const p=this.read(uri,seed);p.raw=Math.max(p.raw,stamp(at));
  if(settled){p.base=Math.max(p.base,p.raw,...p.posts.map(post=>post.at));p.posts=[];}
  this.write(uri,p);
 }
 created(uri:string,creation:Creation,seed:number){
  const checked=checkedCreation(creation),p=this.read(uri,seed);if(p.creation&&(p.creation.creatorSessionId!==checked.creatorSessionId||p.creation.requestId!==checked.requestId))throw Error('Creation provenance is immutable');
  p.creation=checked;this.write(uri,p);
 }
}
