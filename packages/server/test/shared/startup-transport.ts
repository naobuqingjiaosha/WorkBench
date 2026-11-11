import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,basename} from 'node:path';
import {pathToFileURL} from 'node:url';

// A test-only native-protocol fault: reject inputFS requests with the same
// error shape as service.go's failed os.Remove, without changing any OS policy.
// All non-file requests still reach the real locked esbuild binary.
if(process.env.STARTUP_TRANSPORT_FAULT){
 const require=createRequire(import.meta.url),cp=require('node:child_process'),fs=require('node:fs');
 const spawn=cp.spawn,write=fs.writeFile;
 const trace=(event:string)=>fs.appendFileSync(process.env.STARTUP_TRANSPORT_TRACE!,event+'\n');
 fs.writeFile=function(file:any,...args:any[]){if(basename(String(file)).startsWith('esbuild-'))trace('temp-write');return write.call(this,file,...args);};
 const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
 const str=(s:string)=>{const b=Buffer.from(s);return Buffer.concat([u32(b.length),b]);};
 function decode(packet:Buffer){
  let offset=8;
  const integer=()=>{const n=packet.readUInt32LE(offset);offset+=4;return n;};
  const bytes=()=>{const n=integer(),b=packet.subarray(offset,offset+n);offset+=n;return b;};
  function value():any{
   switch(packet[offset++]){
    case 0:return null;case 1:return !!packet[offset++];case 2:return integer();case 3:return bytes().toString();case 4:return bytes();
    case 5:return Array.from({length:integer()},()=>value());
    case 6:{const n=integer(),v:Record<string,any>={};for(let i=0;i<n;i++)v[bytes().toString()]=value();return v;}
    default:throw Error('unknown test protocol tag');
   }
  }
  const result=value();assert.equal(offset,packet.length);return result;
 }
 cp.spawn=function(command:any,args:any[],...rest:any[]){
  const child=spawn.call(this,command,args,...rest);
  if(args?.some(a=>String(a).startsWith('--service='))){
   const write=child.stdin.write.bind(child.stdin);
   child.stdin.write=(data:any,callback:any)=>{
    const packet=Buffer.from(data),request=decode(packet);
    if(request.command==='transform'){
     trace(request.inputFS?'input-file':'input-pipe');
     if(request.inputFS||process.env.STARTUP_TRANSPORT_FAULT==='all'){
      const body=Buffer.concat([u32(packet.readUInt32LE(4)|1),Buffer.from([6]),u32(1),str('error'),Buffer.from([3]),str('remove synthetic esbuild-temp: Access is denied')]);
      queueMicrotask(()=>{child.stdout.emit('data',Buffer.concat([u32(body.length),body]));callback?.();});
      return true;
     }
    }
    return write(data,callback);
   };
  }
  return child;
 };
 syncBuiltinESMExports();
}else{
 const root=process.cwd(),temp=process.env.WORKBENCH_ISOLATION_ROOT!;
 const adapter=pathToFileURL(join(root,'scripts/esbuild-transport.mjs')).href,self=pathToFileURL(import.meta.filename).href;
 const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
 const original=readFileSync(join(root,'node_modules/esbuild/lib/main.js'));
 const probe=`
  const {transform}=await import('esbuild');
  const cases=[
   ['const n: number=3',{loader:'ts'}],
   ['/*'+'x'.repeat(1024*1024)+'*/export const n: number=3',{loader:'ts',minify:true,target:'es2018',sourcemap:true}],
   ['export const text: string='+JSON.stringify('合成中文 synthetic '.repeat(100000)),{loader:'ts',minify:true,format:'esm',sourcemap:true}],
   [new TextEncoder().encode('/*'+'x'.repeat(2*1024*1024)+'*/const node=<div>合成</div>'),{loader:'tsx',jsx:'automatic',sourcemap:true}],
   ['/*'+'x'.repeat(2*1024*1024)+'*/.test {color: #ffffff}',{loader:'css',minify:true,sourcemap:true}]
  ];
  const {createHash}=await import('node:crypto');
  const results=[];
  for(const [input,options] of cases){const r=await transform(input,options);results.push(createHash('sha256').update(JSON.stringify(r)).digest('hex'));}
  console.log(JSON.stringify(results));
 `;
 function run(name:string,adapted:boolean,fault:boolean,script:string){
  const dir=join(temp,name);mkdirSync(dir);const trace=join(dir,'trace');writeFileSync(trace,'');
  const env={...process.env,...(fault?{STARTUP_TRANSPORT_FAULT:'1',STARTUP_TRANSPORT_TRACE:trace}:{})};
  // The runner's isolation preflight must see the original system temp parent.
  // Redirect only compiler scratch IO after that guard has validated the root.
  const input=`for(const key of ['TMPDIR','TEMP','TMP'])process.env[key]=${JSON.stringify(dir)};\n`+script;
  const result=spawnSync(process.execPath,[...(fault?['--import',self]:[]),...(adapted?['--import',adapter]:[]),'--input-type=module','-e',input],{cwd:root,env,encoding:'utf8',maxBuffer:8*1024*1024,timeout:60000});
  assert.ifError(result.error);return {...result,trace:readFileSync(trace,'utf8'),dir};
 }
 const before=run('before',false,false,probe);assert.equal(before.status,0,before.stderr);
 const failed=run('before-fault',false,true,probe);assert.notEqual(failed.status,0);assert.match(failed.stderr,/remove synthetic esbuild-temp: Access is denied/);assert.match(failed.trace,/temp-write\ninput-file/);
 const after=run('after-fault',true,true,probe);assert.equal(after.status,0,after.stderr);assert.equal(after.stdout,before.stdout);assert.ok(!after.trace.includes('temp-write'));assert.ok(!after.trace.includes('input-file'));assert.equal(after.trace.trim().split('\n').length,5);
 assert.deepEqual(readdirSync(after.dir),['trace']);
 const invalid=run('invalid',true,true,`const e=await import('esbuild');await e.transform('/*'+'x'.repeat(2**21)+'*/const =',{loader:'ts'});`);assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/Transform failed/);
 assert.equal(hash(readFileSync(join(root,'node_modules/esbuild/lib/main.js'))),hash(original));
 console.log('esbuild传输：修前删除故障注入失败；修后5种输入/大输出/映射与原编译结果逐字节一致，零临时传输文件；语法错误仍失败，安装文件未修改');
}
