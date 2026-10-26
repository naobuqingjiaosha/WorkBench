import ExcelJS from 'exceljs';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync,copyFileSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {readOfficeBytes} from '../core/office-package.ts';
import {ApiError} from '../api/reply.ts';
import {assertNoPathLinks} from '../core/path-boundary.ts';

export const ledgerKeys=['project','inspection_date','subject','method','content','findings','rectification','remarks','supervisor','supervised_unit','small_power'] as const;
export type LedgerFields=Record<typeof ledgerKeys[number],string>;
export type LedgerMeta={sheets:Record<string,{keyColumn:number;columns:Record<string,number>}>;templates?:{work?:string;supervision?:string}};
export const emptyFields=():LedgerFields=>Object.fromEntries(ledgerKeys.map(k=>[k,''])) as LedgerFields;
export const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export async function loadBook(path:string){assertNoPathLinks(path);const book=new ExcelJS.Workbook();await book.xlsx.load(readOfficeBytes(path) as never);if(!book.worksheets.length)throw new ApiError('BAD_BOOK','工作簿没有可读取的工作表');return book;}
export function cellText(c:ExcelJS.Cell){if(c.value instanceof Date)return c.value.toISOString().slice(0,10);return c.text.trim();}
export function normalizeLedgerDate(value:string){const match=value.match(/^(20\d{2})[.年/-](\d{1,2})[.月/-](\d{1,2})日?$/);if(!match)return value;const d=`${match[1]}-${match[2]!.padStart(2,'0')}-${match[3]!.padStart(2,'0')}`;return d;}
const headers:Record<string,string>={'时间':'inspection_date','监督事项':'subject','监督方式':'method','具体内容':'content','发现问题':'findings','整改情况':'rectification','备注':'remarks'};
export function importLedgerBook(book:ExcelJS.Workbook){
 const meta:LedgerMeta={sheets:{}},entries:{id:string;fields:LedgerFields}[]=[],issues:string[]=[];
 for(const s of book.worksheets){
  if(s.name.startsWith('_workbench'))continue;
  const columns:Record<string,number>={};let header=0;
  for(let r=1;r<=Math.min(10,s.rowCount);r++)if(s.getRow(r).values?.toString().includes('监督事项')){header=r;s.getRow(r).eachCell((c,col)=>{const key=headers[c.text.trim()];if(key)columns[key]=col;});break;}
  if(Object.keys(columns).length!==7)throw new ApiError('LEDGER_LAYOUT',`${s.name} 未识别完整八栏台账，请核对表头；不猜测导入`);
  const keyColumn=Math.max(14,s.columnCount+1);s.getColumn(keyColumn).hidden=true;s.getCell(header,keyColumn).value='_workbench_record_id';
  meta.sheets[s.name]={keyColumn,columns};
  for(let r=header+1;r<=s.rowCount;r++){
   if(!Object.values(columns).some(c=>cellText(s.getCell(r,c))))continue;
   const f=emptyFields();f.project=s.name;for(const [key,col]of Object.entries(columns))f[key as keyof LedgerFields]=cellText(s.getCell(r,col));f.inspection_date=normalizeLedgerDate(f.inspection_date);
   const id=randomUUID();s.getCell(r,keyColumn).value=id;entries.push({id,fields:f});
   if(!/^20\d{2}-\d{2}-\d{2}$/.test(f.inspection_date))issues.push(`${s.name} 第${r}行日期待核对：${f.inspection_date||'空'}`);
  }
 }
 if(!Object.keys(meta.sheets).length)throw new ApiError('EMPTY_LEDGER','没有可识别的项目台账');return {meta,entries,issues};
}
export function readLedgerRows(book:ExcelJS.Workbook,meta:LedgerMeta){
 const rows=new Map<string,{fields:Partial<LedgerFields>;sheet:ExcelJS.Worksheet;row:number}>();const issues:string[]=[];
 for(const [name,m]of Object.entries(meta.sheets)){
  const s=book.getWorksheet(name);if(!s){issues.push(`项目工作表“${name}”被改名或删除，需确认关联`);continue;}
  for(let r=3;r<=s.rowCount;r++){
   const id=s.getCell(r,m.keyColumn).text.trim();const populated=Object.values(m.columns).some(c=>cellText(s.getCell(r,c)));
   if(!id){if(populated)issues.push(`${name} 第${r}行无记录关联，待确认后导入`);continue;}
   if(rows.has(id)){issues.push(`${name} 第${r}行记录关联重复，停止自动同步`);continue;}
   const f:Partial<LedgerFields>={};for(const [key,c]of Object.entries(m.columns))f[key as keyof LedgerFields]=cellText(s.getCell(r,c));f.inspection_date=normalizeLedgerDate(f.inspection_date??'');rows.set(id,{fields:f,sheet:s,row:r});
  }
 }
 return {rows,issues};
}
export function writeLedgerEntry(book:ExcelJS.Workbook,meta:LedgerMeta,id:string,fields:LedgerFields){
 let located=readLedgerRows(book,meta).rows.get(id);
 if(!located){
  let s=book.getWorksheet(fields.project);if(!s){
   const model=book.worksheets.find(s=>!s.name.startsWith('_workbench'))!;
   if(!fields.project.trim()||fields.project.length>31||/[\[\]*?:/\\]/.test(fields.project))throw new ApiError('SHEET_NAME','新项目工作表名称须不超过31字，不能含 Excel 禁用字符');
   s=book.addWorksheet(fields.project);s.model={...structuredClone(model.model),id:s.id,name:fields.project};
   const source=meta.sheets[model.name]!;meta.sheets[fields.project]=structuredClone(source);
   for(let r=3;r<=s.rowCount;r++)s.getRow(r).eachCell(c=>c.value=null);
   s.getCell('A1').value=fields.project+'（项目）廉政监督员日常监督工作台账';
  }
  const m=meta.sheets[s.name]!;let r=3;while(s.getCell(r,m.keyColumn).text||Object.values(m.columns).some(c=>cellText(s!.getCell(r,c))))r++;
  const sample=s.getRow(Math.max(3,r-1));for(let c=1;c<=8;c++)s.getCell(r,c).style=structuredClone(sample.getCell(c).style);s.getRow(r).height=sample.height??60;
  s.getCell(r,1).value=r-2;s.getCell(r,m.keyColumn).value=id;located={sheet:s,row:r,fields:{}};
 }
 const m=meta.sheets[located.sheet.name]!;for(const [key,c]of Object.entries(m.columns))located.sheet.getCell(located.row,c).value=fields[key as keyof LedgerFields];
 located.sheet.pageSetup.printArea=`A1:H${Math.max(located.sheet.rowCount,located.row)}`;
}
export function formFields(kind:string,f:LedgerFields):Record<string,string>{
 // Confirmed business mapping: work-record inspection content is the ledger subject.
 return kind==='work'?{B2:f.project,B3:f.inspection_date,B4:f.subject,B5:f.findings}:
 {A3:`（监督时间：${f.inspection_date||'待补'}）`,A4:`监督人员姓名：${f.supervisor||'待补'}    接受监督单位：${f.supervised_unit||'待补'}`,A6:'1',B6:f.project+'\n'+f.subject,C6:f.content,D6:f.findings,E6:f.rectification,F6:f.remarks};
}
export const fieldCells:Record<string,Record<string,string>>={work:{project:'B2',inspection_date:'B3',subject:'B4',findings:'B5'},supervision:{content:'C6',findings:'D6',rectification:'E6',remarks:'F6'}};
export function writeForm(book:ExcelJS.Workbook,kind:string,f:LedgerFields,docId:string,entryId:string){
 const s=book.worksheets.find(s=>s.name!=='_workbench_link')!;for(const [cell,value]of Object.entries(formFields(kind,f)))s.getCell(cell).value=value;
 if(kind==='supervision'){
  let lines=1;for(const col of ['B','C','D','E','F']){const cell=s.getCell(`${col}6`);cell.alignment={...cell.alignment,wrapText:true,vertical:'middle'};const width=Math.max(4,Math.floor((s.getColumn(col).width??12)/2));lines=Math.max(lines,cell.text.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length/width)),0));}
  s.getRow(6).height=Math.max(s.getRow(6).height??80,Math.min(400,lines*15+16));
 }
 let m=book.getWorksheet('_workbench_link');if(!m)m=book.addWorksheet('_workbench_link');m.state='veryHidden';m.getCell('A1').value='workbench-linked-form-v1';m.getCell('A2').value=docId;m.getCell('A3').value=entryId;m.getCell('A4').value=kind;
}
export function readForm(book:ExcelJS.Workbook,kind:string,id:string,entry:string){
 const m=book.getWorksheet('_workbench_link');if(!m||m.getCell('A1').text!=='workbench-linked-form-v1'||m.getCell('A2').text!==id||m.getCell('A3').text!==entry||m.getCell('A4').text!==kind)throw new ApiError('UNLINKED','文件关联标识缺失或不一致，待确认，未写回');
 const s=book.worksheets.find(s=>s.name!=='_workbench_link')!;const values:Partial<LedgerFields>={};for(const [field,cell]of Object.entries(fieldCells[kind]??{}))values[field as keyof LedgerFields]=cellText(s.getCell(cell));
 if(kind==='supervision'){
  const content=cellText(s.getCell('B6')),split=content.indexOf('\n');if(split<0)throw new ApiError('FORM_LAYOUT','监督内容中的项目和事项分隔已变化，请保留项目首行并核对');values.project=content.slice(0,split);values.subject=content.slice(split+1);
  const date=cellText(s.getCell('A3')).match(/监督时间[：:]\s*(.*?)\s*[)）]/);if(!date)throw new ApiError('FORM_LAYOUT','监督时间栏目无法识别');values.inspection_date=date[1]==='待补'?'':date[1];
  const people=cellText(s.getCell('A4')).match(/监督人员姓名[：:]\s*(.*?)\s+接受监督单位[：:]\s*(.*)/);if(!people)throw new ApiError('FORM_LAYOUT','监督人员或单位栏目无法识别');values.supervisor=people[1]==='待补'?'':people[1];values.supervised_unit=people[2]==='待补'?'':people[2];
 }
 if(values.inspection_date)values.inspection_date=normalizeLedgerDate(values.inspection_date);return values;
}
/** Every replaced file gets an immutable backup; compare bytes again immediately before rename. */
export async function saveBookVersion(path:string,book:ExcelJS.Workbook,expected:string|null){
 assertNoPathLinks(path);mkdirSync(dirname(path),{recursive:true});const bytes=Buffer.from(await book.xlsx.writeBuffer()),temp=path+'.'+randomUUID()+'.tmp';
 writeFileSync(temp,bytes,{flag:'wx'});
 if(expected!==null){if(!existsSync(path)||hash(readFileSync(path))!==expected)throw new ApiError('FILE_CHANGED','文件在处理期间再次变化，未覆盖，请重新同步',409);const versions=join(dirname(path),'.versions');mkdirSync(versions,{recursive:true});copyFileSync(path,join(versions,randomUUID()+'.xlsx'));}
 else if(existsSync(path))throw new ApiError('FILE_EXISTS','目标文件已存在，未覆盖',409);
 renameSync(temp,path);return hash(bytes);
}
