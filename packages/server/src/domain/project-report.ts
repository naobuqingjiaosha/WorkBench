import type ExcelJS from 'exceljs';
import {ApiError} from '../api/reply.ts';

export type ProjectReportRow={key:string;sheet:string;row:number;name:string;unit:string;completed:string;progress:string;duplicate:boolean};
export type ProjectReportSelection={id:string;digest:string;month:string;sourceName?:string;monthConfirmed:boolean;mergeConfirmed:boolean;choices:{key:string;name:string;target:string;alias:boolean}[]};
const normalized=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');
const headers=['项目名称','项目建设单位','本月完成情况','累计完成比例'] as const;

/** Read only the report's explicit columns. Plans and percentages never select rows. */
export function parseProjectReport(book:ExcelJS.Workbook,month:string){
 if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))throw new ApiError('BAD_MONTH','请先选择有效办理年月');
 const candidates:{sheet:ExcelJS.Worksheet;row:number;columns:Record<string,number>}[]=[];
 for(const sheet of book.worksheets){
  if(sheet.rowCount>10000||sheet.columnCount>400)throw new ApiError('TOO_LARGE','月报超过10000行或400列，请先拆分核对');
  sheet.eachRow((row,r)=>{
   const found:Record<string,number[]>={};row.eachCell((cell,c)=>{const text=normalized(cell.text);if(headers.includes(text as typeof headers[number]))(found[text]??=[]).push(c);});
   if(headers.slice(0,3).every(h=>found[h]?.length)){
    if(Object.values(found).some(cols=>cols.length!==1))throw new ApiError('REPORT_HEADER_AMBIGUOUS',`${sheet.name}第${r}行存在重复月报字段，请保留一组明确表头`);
    candidates.push({sheet,row:r,columns:Object.fromEntries(Object.entries(found).map(([k,v])=>[k,v[0]!]))});
   }
  });
 }
 if(candidates.length!==1)throw new ApiError('REPORT_HEADER_AMBIGUOUS',candidates.length?'发现多组月报表头，请明确保留本次要采用的一张项目月报':'未找到唯一月报表头：须包含项目名称、项目建设单位、本月完成情况；空页会跳过');
 const {sheet,row:headerRow,columns}=candidates[0]!;
 const titleValues=new Set<string>();
 for(let r=1;r<headerRow;r++)sheet.getRow(r).eachCell(c=>{if(/月报/.test(normalized(c.text)))titleValues.add(normalized(c.text));});
 const titles=[...titleValues];const months=new Set<number>(),years=new Set<number>();
 for(const title of titles){
  for(const m of title.matchAll(/(20\d{2})年/g))years.add(Number(m[1]));
  for(const m of title.matchAll(/(?:(20\d{2})年)?(\d{1,2})月/g)){months.add(Number(m[2]));if(m[1])years.add(Number(m[1]));}
  for(const m of title.matchAll(/(20\d{2})[-/](\d{1,2})(?!\d)/g)){years.add(Number(m[1]));months.add(Number(m[2]));}
 }
 if(months.size>1||years.size>1)throw new ApiError('REPORT_MONTH_AMBIGUOUS','月报标题包含多个年月，请核对本次资料范围');
 if([...months].some(m=>m!==Number(month.slice(5)))||[...years].some(y=>y!==Number(month.slice(0,4))))throw new ApiError('WRONG_MONTH','月报标题年月与办理月份不符，请选择正确期次或资料');
 const rows:ProjectReportRow[]=[];
 for(let r=headerRow+1;r<=sheet.rowCount;r++){
  const cells=headers.map(h=>columns[h]?sheet.getCell(r,columns[h]!):undefined);
  if(cells.every(c=>!c?.text.trim()))continue;
  if(cells.some(c=>c?.type===6))throw new ApiError('REPORT_FORMULA',`月报第${r}行含公式字段，请先核对为明确文本值`);
  const [name='',unit='',completed='',progress='']=cells.map(c=>c?.text.trim()??'');
  if(!name||name.length>300||unit.length>1000||completed.length>20000||progress.length>1000)throw new ApiError('REPORT_ROW',`月报第${r}行项目名称缺失或字段过长，请核对`);
  rows.push({key:JSON.stringify([sheet.name,r]),sheet:sheet.name,row:r,name,unit,completed,progress,duplicate:false});
 }
 if(!rows.length||rows.length>500)throw new ApiError('REPORT_ROWS','月报须包含1至500项可核对项目');
 for(const item of rows)item.duplicate=rows.filter(r=>normalized(r.name)===normalized(item.name)).length>1;
 return {month,titleMonth:[...months][0]??null,titleYear:[...years][0]??null,rows,
  warning:years.size?'请核对所选项目、正式名称及办理年月后采用':'标题未独立证明年份；办理年月必须由你核对确认，不自动补当前年'};
}

/** Explicit template catalog headers only; no inference of clients from construction units. */
export function templateProjectCatalog(book:ExcelJS.Workbook){
 const items:{name:string;sheet:string;row:number;customer:string;contract:string}[]=[];
 const warnings:string[]=[];
 for(const sheet of book.worksheets){
  const candidates:{row:number;cols:Record<string,number[]>}[]=[];
  sheet.eachRow((row,r)=>{const cols:Record<string,number[]>={};row.eachCell((c,n)=>{const h=normalized(c.text);if(['项目名称','客户名称','合同编号'].includes(h))(cols[h]??=[]).push(n);});if(cols['项目名称']&&(cols['客户名称']||cols['合同编号']))candidates.push({row:r,cols});});
  if(!candidates.length)continue;
  if(candidates.length!==1||Object.values(candidates[0]!.cols).some(v=>v.length!==1)){warnings.push(`${sheet.name}的经营项目明细表头有歧义，未提取建议，请人工核对`);continue;}
  const {row,cols}=candidates[0]!;
  for(let r=row+1;r<=sheet.rowCount;r++){
   const read=(key:string)=>cols[key]?sheet.getCell(r,cols[key]![0]!).text.trim():'';
   const name=read('项目名称');if(!name)continue;
   if(name.length>300||['项目名称','客户名称','合同编号'].some(k=>cols[k]&&sheet.getCell(r,cols[k]![0]!).type===6)){warnings.push(`${sheet.name}第${r}行不能可靠提取，保留待人工核对`);continue;}
   items.push({name,sheet:sheet.name,row:r,customer:read('客户名称'),contract:read('合同编号')});
  }
 }
 return {items,warnings};
}

export function validateProjectReportSelection(selection:ProjectReportSelection,report:ReturnType<typeof parseProjectReport>){
 if(!selection.monthConfirmed||selection.month!==report.month||!selection.choices.length)throw new ApiError('REPORT_UNCONFIRMED','请核对月报月份和所选项目后明确采用');
 const seen=new Set<string>(),targets=new Set<string>();let merged=false;
 for(const c of selection.choices){
  const row=report.rows.find(r=>r.key===c.key);
  if(!row||row.name!==c.name||seen.has(c.key)||!c.target.trim()||c.target.length>300)throw new ApiError('REPORT_SELECTION','月报选择或正式名称不一致，请重新核对');
  seen.add(c.key);if(targets.has(c.target))merged=true;targets.add(c.target);
  if(c.alias&&(c.name.trim().length<2||selection.choices.some(other=>other.name===c.name&&other.target!==c.target)))throw new ApiError('REPORT_ALIAS','同名来源无法映射到不同正式项目，或简称未明确确认');
 }
 if(merged&&!selection.mergeConfirmed)throw new ApiError('REPORT_MERGE','多行映射到同一正式项目，须明确确认合并');
}
