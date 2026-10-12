/** Short-lived, read-only transports. Every use still rechecks native identity. */
export class PassiveMediaReaders<T> {
  private entries=new Map<string,{ready:Promise<T>;tail:Promise<unknown>;pending:number;timer?:ReturnType<typeof setTimeout>}>();
  private closed=false;
  constructor(private open:(key:string)=>Promise<T>,private retire:(value:T)=>Promise<void>,private idleMs=3000){}
  get size(){return this.entries.size;}
  async use<R>(key:string,work:(value:T)=>Promise<R>):Promise<R>{
    if(this.closed)throw Error('Media readers are closed');
    let entry=this.entries.get(key);
    if(!entry){
      if(this.entries.size>=2)throw Error('Media reader capacity reached');
      entry={ready:Promise.resolve().then(()=>this.open(key)),tail:Promise.resolve(),pending:0};
      this.entries.set(key,entry);
    }
    if(entry.pending>=20)throw Error('Media reader queue capacity reached');
    clearTimeout(entry.timer);entry.pending++;
    const selected=entry;
    const result=selected.tail.catch(()=>{}).then(async()=>{
      if(this.closed)throw Error('Media readers are closed');
      return work(await selected.ready);
    });
    selected.tail=result;
    try{return await result;}
    finally{
      selected.pending--;
      if(!selected.pending&&!this.closed){selected.timer=setTimeout(()=>{void this.release(key,selected);},this.idleMs);selected.timer.unref();}
    }
  }
  private async release(key:string,entry:{ready:Promise<T>;tail:Promise<unknown>;pending:number;timer?:ReturnType<typeof setTimeout>}){
    if(this.entries.get(key)!==entry||entry.pending)return;
    this.entries.delete(key);clearTimeout(entry.timer);
    try{await this.retire(await entry.ready);}catch{/* Failed opens already released their admission. */}
  }
  async close(){
    this.closed=true;
    const entries=[...this.entries.entries()];
    await Promise.all(entries.map(async([key,entry])=>{clearTimeout(entry.timer);await entry.tail.catch(()=>{});await this.release(key,entry);}));
  }
}
