import {spawn} from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
export class WriterClient {
  constructor(root,dataRoot){this.root=root;this.dataRoot=dataRoot;this.pending=new Map();this.seq=0;}
  start(){
    if(this.child)return;
    const child=spawn(path.join(this.root,'runtime','python.exe'),['-u',path.join(this.root,'engine','bridge.py')],{cwd:this.root,windowsHide:true,env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',NOVEL_FACTORY_DATA_DIR:this.dataRoot},stdio:['pipe','pipe','pipe']});
    this.child=child;this.diagnostic='';child.stderr.on('data',b=>{this.diagnostic=(this.diagnostic+b.toString()).slice(-2000);});
    readline.createInterface({input:child.stdout}).on('line',line=>{try{const r=JSON.parse(line),p=this.pending.get(r.id);if(p){clearTimeout(p.timer);this.pending.delete(r.id);r.ok?p.resolve(r.data):p.reject(new Error(r.error));}}catch{}});
    const fail=e=>{if(this.child===child)this.child=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(e.message||'写作引擎退出，请重试'));}this.pending.clear();};
    child.on('error',fail);child.on('exit',()=>fail(new Error('写作引擎已停止 '+this.diagnostic)));
  }
  call(method,data={}){this.start();return new Promise((resolve,reject)=>{const id=++this.seq,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('写作引擎响应超时，请检查任务状态后重试'));},method==='ideas'?7200000:120000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,data})+'\n');});}
  close(){this.child?.stdin.end();this.child?.kill();}
}
