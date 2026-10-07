interface Admission { done:Promise<void>; resolve:()=>void; bytes:number; }

/** Join wire-received native events before settling an input. SDK notification
 * dispatch is asynchronous and can be overtaken by the following RPC response.
 * Only join callback admission: its asynchronous continuation may itself need
 * the completed RPC or a Host lock. Never serialize the duplex transport. */
export class NativeEventIntake {
  private pending=new Map<object,Admission>();
  private bytes=0;
  private fault?:Error;
  observe(params:unknown) {
    if(!params||typeof params!=='object'||Array.isArray(params))return;
    const bytes=Buffer.byteLength(JSON.stringify(params));
    if(this.pending.size>=512||this.bytes+bytes>8*1024*1024){this.fail(new Error('Native event intake capacity exceeded'));throw this.fault;}
    let resolve!:()=>void;
    const done=new Promise<void>(accept=>{resolve=accept;});
    this.pending.set(params,{done,resolve,bytes});this.bytes+=bytes;
  }
  admit(params:object) {
    const entry=this.pending.get(params);
    if(!entry){this.fail(new Error('Native event callback has no wire admission'));return;}
    this.pending.delete(params);this.bytes-=entry.bytes;entry.resolve();
  }
  fail(error:unknown) {
    this.fault??=error instanceof Error?error:new Error(String(error));
    for(const entry of this.pending.values())entry.resolve();
    this.pending.clear();this.bytes=0;
  }
  closed() {if(this.pending.size)this.fail(new Error('ACP closed before native events were admitted'));}
  async drain(timeoutMs=5000) {
    // Snapshot only frames already received before the RPC response. Later
    // background events must not prolong or acquire this input's settlement.
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      if(this.pending.size)await Promise.race([
        Promise.all([...this.pending.values()].map(entry=>entry.done)),
        new Promise<void>(resolve=>{timer=setTimeout(()=>{this.fail(new Error('Native event admission was not confirmed'));resolve();},timeoutMs);timer.unref();}),
      ]);
      if(this.fault)throw this.fault;
    }finally{clearTimeout(timer);}
  }
}
