import PizZip from 'pizzip';
import {inflateRawSync} from 'node:zlib';
import {readFileSync} from 'node:fs';

export const OFFICE_LIMITS={compressed:32*1024*1024,total:64*1024*1024,entry:16*1024*1024,entries:4096,ratio:2000};
/** Validate declared sizes AND actual bounded inflation before any Office parser sees the bytes.
 * ZIP64, encrypted, ambiguous names, overlapping entries and unsupported compression fail closed.
 * No files are extracted. Bounds apply to disk input as well as uploads.
 */
export function checkedOfficeBytes(input:Buffer|Uint8Array|ArrayBuffer,limits=OFFICE_LIMITS):Buffer {
 const b=Buffer.isBuffer(input)?input:Buffer.from(input instanceof ArrayBuffer?new Uint8Array(input):input);
 const bad=(why:string):never=>{throw new Error(`Office包资源或结构检查未通过：${why}`);};
 if(b.length>limits.compressed||b.length<22)bad('压缩包大小无效或超过上限');
 let end=-1;
 for(let n=b.length-22;n>=Math.max(0,b.length-65557);n--)if(b.readUInt32LE(n)===0x06054b50&&n+22+b.readUInt16LE(n+20)===b.length){end=n;break;}
 if(end<0)bad('缺少ZIP目录');
 const count=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),start=b.readUInt32LE(end+16);
 if(b.readUInt16LE(end+4)||b.readUInt16LE(end+6)||b.readUInt16LE(end+8)!==count||count===65535||start===0xffffffff||size===0xffffffff)bad('不支持多卷或ZIP64');
 if(count>limits.entries||start+size!==end)bad('目录数量或范围无效');
 let at=start,total=0;const names=new Set<string>(),ranges:{start:number;end:number}[]=[];
 for(let n=0;n<count;n++){
  if(at+46>end||b.readUInt32LE(at)!==0x02014b50)bad('目录条目损坏');
  const flags=b.readUInt16LE(at+8),method=b.readUInt16LE(at+10),compressed=b.readUInt32LE(at+20),expanded=b.readUInt32LE(at+24),nl=b.readUInt16LE(at+28),el=b.readUInt16LE(at+30),cl=b.readUInt16LE(at+32),local=b.readUInt32LE(at+42);
  if(at+46+nl+el+cl>end||local+30>start)bad('条目范围无效');
  const name=b.subarray(at+46,at+46+nl).toString('utf8');
  if(!name||names.has(name)||name.includes('\\')||name.startsWith('/')||name.split('/').includes('..')||name.includes('\0'))bad('重名或不安全文件名');names.add(name);
  if(flags&1||![0,8].includes(method)||expanded>limits.entry||compressed===0xffffffff||expanded===0xffffffff)bad('加密、压缩方法或单项展开大小不支持');
  total+=expanded;if(total>limits.total||expanded>Math.max(1,compressed)*limits.ratio)bad('总展开大小或压缩比超过上限');
  if(b.readUInt32LE(local)!==0x04034b50||b.readUInt16LE(local+6)!==flags||b.readUInt16LE(local+8)!==method)bad('本地头与目录不一致');
  const lnl=b.readUInt16LE(local+26),lel=b.readUInt16LE(local+28),data=local+30+lnl+lel;
  if(data+compressed>start||b.subarray(local+30,local+30+lnl).toString('utf8')!==name)bad('本地内容范围或名称不一致');
  if(!(flags&8)&&(b.readUInt32LE(local+18)!==compressed||b.readUInt32LE(local+22)!==expanded))bad('本地大小与目录不一致');
  const stop=data+compressed;
  if(ranges.some(r=>local<r.end&&stop>r.start))bad('条目重叠');ranges.push({start:local,end:stop});
  const packed=b.subarray(data,stop);
  let actual:Buffer;
  try{actual=method===0?packed:inflateRawSync(packed,{maxOutputLength:Math.max(1,Math.min(expanded+1,limits.entry+1,limits.total+1))});}
  catch{bad('实际展开超过限制或压缩流损坏');}
  if(actual!.length!==expanded)bad('实际展开大小与声明不一致');
  at+=46+nl+el+cl;
 }
 if(at!==end)bad('目录长度不一致');
 return b;
}
export function readOfficeBytes(path:string):Buffer{return checkedOfficeBytes(readFileSync(path));}
export default class OfficeZip extends PizZip {
 constructor(data?:Buffer|Uint8Array|ArrayBuffer){super();if(data!==undefined)this.load(checkedOfficeBytes(data));}
}
