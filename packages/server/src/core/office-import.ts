import {spawn} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {INSTALL_ROOT,RUNTIME_ROOT} from './config.ts';
import {ApiError} from '../api/reply.ts';
const ole=Buffer.from('d0cf11e0a1b11ae1','hex');
/** Convert an uploaded, read-only copy. Original bytes are retained; macros and external links are disabled. */
export async function normalizeExcel(bytes:Buffer):Promise<Buffer>{
 if(!bytes.subarray(0,8).equals(ole))return bytes;
 if(process.platform!=='win32')throw new ApiError('LEGACY_EXCEL','此文件实际为旧版 XLS，请先另存为 XLSX');
 const dir=join(RUNTIME_ROOT,'office-import',randomUUID());mkdirSync(dir,{recursive:true});
 const input=join(dir,'source.xls'),output=join(dir,'normalized.xlsx');writeFileSync(input,bytes,{flag:'wx'});
 await new Promise<void>((resolve,reject)=>{
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(INSTALL_ROOT,'scripts','convert-legacy-excel.ps1'),'-InputFile',input,'-OutputFile',output],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let error='';child.stderr.on('data',d=>error+=d);const timer=setTimeout(()=>{child.kill();reject(new ApiError('EXCEL_TIMEOUT','Excel 转换超时，请手动另存为 XLSX 后上传；原副本已保留',503));},60000);
  child.on('error',()=>{clearTimeout(timer);reject(new ApiError('EXCEL_UNAVAILABLE','需要本机 Microsoft Excel 转换旧格式，或手动另存为 XLSX'));});
  child.on('exit',code=>{clearTimeout(timer);if(code===0&&existsSync(output))resolve();else reject(new ApiError('EXCEL_CONVERSION','旧格式转换失败，请用 Excel 另存为 XLSX 后上传',422,{detail:error.slice(-800)}));});
 });
 return readFileSync(output);
}
