import type ExcelJS from 'exceljs';
import {captureTemplateFormulas,departmentFooterFormula,isDepartmentFooter,managedPersonnelSummary,personDepartmentFormula,reconcileTemplateFormulas} from './timesheet-formulas.ts';
import {ApiError} from '../api/reply.ts';
import {departmentLayout,monthDays,type RunInput,type Calculation} from './timesheets.ts';

/** Keep the supplied workbook. Only date columns, selected people/project rows and dependent totals change. */
export async function prepareDepartmentBook(book:ExcelJS.Workbook,input:RunInput,result?:Calculation,confirmedProjectsOnly=false){
 const layout=departmentLayout(book,input.month),s=layout.sheet,count=monthDays(input.month),year=Number(input.month.slice(0,4)),month=Number(input.month.slice(5));
 const shifts=captureTemplateFormulas(book,layout,input.requiredPeople,confirmedProjectsOnly?input.projects:undefined,confirmedProjectsOnly);
 const retainedRd=s.getRows(1,s.rowCount)?.filter(r=>r.getCell(4).text.trim()==='研发工时').map(r=>({row:r.number,cells:Array.from({length:s.columnCount},(_,i)=>({value:structuredClone(r.getCell(i+1).value),style:structuredClone(r.getCell(i+1).style)}))}))??[];
 let total=layout.totalCol;
 if(total<40){
  const additions=40-total,style=structuredClone(s.getColumn(total-1).style),width=s.getColumn(total-1).width;
  s.spliceColumns(total,0,...Array.from({length:additions},()=>[]));
  for(let c=total;c<40;c++){s.getColumn(c).style=structuredClone(style);s.getColumn(c).width=width;}
  total=40;
  // These source rows are reference data, not department allocation rows.
  for(const saved of retainedRd){const row=s.getRow(saved.row);row.eachCell(c=>{c.value=null;});saved.cells.forEach((c,i)=>{row.getCell(i+1).value=c.value;row.getCell(i+1).style=c.style;});}
 }
 const cover=book.getWorksheet('封面');if(cover){cover.getCell('C8').value=year;cover.getCell('E8').value=month;}
 for(let d=1;d<=31;d++){
  s.getCell(layout.headerRow,8+d).value=d<=count?new Date(Date.UTC(year,month-1,d)):null;
  s.getCell(layout.headerRow,8+d).numFmt='d';
  s.getCell(layout.headerRow+1,8+d).value=d<=count?'周'+'日一二三四五六'[new Date(Date.UTC(year,month-1,d)).getUTCDay()]:null;
 }
 s.getCell(layout.headerRow,total).value='合计';s.getCell(layout.headerRow+1,total).value='--';
 const wanted=input.requiredPeople;
 const included=(row:{person:string;project:string})=>(!wanted||wanted.includes(row.person))&&(!confirmedProjectsOnly||input.projects.includes(row.project));
 // Unselected people stay as empty, non-person rows so original rows and styles are not deleted.
 for(const row of layout.rows){
  for(let c=9;c<=total;c++)s.getCell(row.row,c).value=null;
  if(!included(row)){s.getRow(row.row).eachCell(c=>{c.value=null;c.note='';});}
  else {s.getCell(row.row,4).value=s.getCell(row.row,4).text.trim();s.getCell(row.row,total).value={formula:`SUM(I${row.row}:AM${row.row})`,result:0};}
 }
 const pairs=layout.rows.filter(included).map(r=>({person:r.person,project:r.project}));
 for(const person of wanted??[]){const assigned=input.assignments[person];const projects=typeof assigned==='string'?[assigned]:assigned??[];
  const targets=[...new Set([...projects,...(result?.days??[]).filter(d=>d.person===person&&d.project&&d.department>0).map(d=>d.project),...(input.overrides??[]).filter(o=>o.person===person&&o.project).map(o=>o.project!),...(input.allocations??[]).filter(o=>o.person===person).flatMap(o=>Object.keys(o.shares))])];
  for(const project of targets)if(!pairs.some(p=>p.person===person&&p.project===project)){
   if(!input.projects.includes(project))throw new ApiError('PROJECT_UNKNOWN','新增行的项目不在已确认清单中');
   const footer=layout.rows.length?Math.max(...layout.rows.map(r=>r.row))+1:layout.headerRow+2;
   const target=s.getRow(footer);s.insertRow(footer,[], 'i');shifts.extraRows++;
   const src=s.getRow(layout.rows[0]!.row);for(let c=1;c<=total;c++)s.getCell(footer,c).style=structuredClone(src.getCell(c).style);
   target.height=src.height;s.getCell(footer,3).value=person;s.getCell(footer,4).value='服务工时';s.getCell(footer,5).value=project;
   s.getCell(footer,total).value={formula:`SUM(I${footer}:AM${footer})`,result:0};pairs.push({person,project});
   layout.rows.push({row:footer,person,project});
  }
 }
 // Repair shifted row totals, clear previous-month comments and all cached hours on selected rows.
 for(let r=layout.headerRow+2;r<=s.rowCount;r++)if(s.getCell(r,3).text&&['服务工时','部门工时'].includes(s.getCell(r,4).text)){
  for(let c=9;c<total;c++){s.getCell(r,c).value=null;s.getCell(r,c).note='';}
  s.getCell(r,total).value={formula:`SUM(I${r}:AM${r})`,result:0};
  for(let c=total+1;c<=s.columnCount;c++)if(/备注/.test(s.getCell(layout.headerRow,c).text))s.getCell(r,c).value=null;
 }
 s.pageSetup.printArea=`A1:${s.getColumn(Math.max(total,s.columnCount)).letter}${s.rowCount}`;
 book.calcProperties.fullCalcOnLoad=true;
 return shifts;
}

// A department template may be last month's finished sheet. Its old research rows
// have no authority for this month's person, project, contract, date or hours.
export function refreshResearchRows(layout:ReturnType<typeof departmentLayout>,result:Calculation) {
 const {sheet,totalCol}=layout;
 const remaining=new Map<string,number[]>();
 for(const day of result.days){
  if(!remaining.has(day.person))remaining.set(day.person,Array(31).fill(0));
  const daily=remaining.get(day.person)!,index=Number(day.date.slice(8))-1;
  daily[index]=(daily[index]??0)+day.rd;
 }
 sheet.eachRow(row=>{
  if(row.getCell(4).text.trim()!=='研发工时')return;
  const person=row.getCell(3).text.trim(),daily=remaining.get(person);
  row.eachCell(cell=>{cell.value=null;cell.note='';});
  if(!daily)return;
  remaining.delete(person);
  row.getCell(3).value=person;row.getCell(4).value='研发工时';
  row.getCell(5).value='本月研发合计（不分项目）';
  daily.forEach((hours,index)=>{if(hours)row.getCell(9+index).value=hours;});
  row.getCell(totalCol).value={formula:`SUM(I${row.number}:${sheet.getColumn(totalCol-1).letter}${row.number})`,result:daily.reduce((a,b)=>a+b,0)};
 });
}

export function refreshTimesheetSummary(book:ExcelJS.Workbook,layout:ReturnType<typeof departmentLayout>,result:Calculation,daysInMonth:number,source?:ReturnType<typeof captureTemplateFormulas>){
 const {sheet:s,rows,totalCol}=layout,first=Math.min(...rows.map(r=>r.row)),last=Math.max(...rows.map(r=>r.row));
 // Reuse our previous footer when a finished workbook becomes the next template.
 // A template may also contain its own combined totals or research subtotals.
 let footer:number|undefined,lastOccupied=last;
 for(let n=last+1;n<=s.rowCount;n++){
  const r=s.getRow(n);
  const owned=source?(source.originalFooter!==undefined&&n===source.originalFooter+source.extraRows):isDepartmentFooter(r,layout,first,last);
  if(owned){footer=n;break;}
  if(r.hasValues)lastOccupied=n;
 }
 const added=footer===undefined;
 footer??=lastOccupied+1;
 s.getCell(footer,3).value='部门工时合计';
 for(let c=9;c<=totalCol;c++){
  if(c!==totalCol&&c>8+daysInMonth){s.getCell(footer,c).value=null;continue;}
  const letter=s.getColumn(c).letter;
  const value=rows.reduce((sum,r)=>{const v=s.getCell(r.row,c);return sum+Number(v.formula?v.result??0:v.value??0);},0);
  s.getCell(footer,c).value={formula:departmentFooterFormula(letter,first,last),result:value};
 }
 s.pageSetup.printArea=`A1:${s.getColumn(Math.max(totalCol,s.columnCount)).letter}${Math.max(footer,s.rowCount)}`;
 let summary=source?source.summary:managedPersonnelSummary(book,layout);
 if(!summary){
  if(!book.worksheets.some(s=>s.name.startsWith('人员工时汇总')))return {row:footer,added};
  let name='人员工时汇总（本次）',n=1;
  while(book.getWorksheet(name))name=`人员工时汇总（本次 ${++n}）`;
  summary=book.addWorksheet(name);
 }
 // The old summary omitted the later people. Rebuild its person-dependent rows over the complete detail range.
 const names=Object.keys(result.personTotals);
 for(const range of [...summary.model.merges])summary.unMergeCells(range);
 for(let r=3;r<=summary.rowCount;r++)for(let c=1;c<=8;c++)summary.getCell(r,c).value=null;
 for(let c=1;c<=8;c++){summary.getCell(1,c).value=null;summary.getCell(2,c).value=null;}
 summary.mergeCells('A1:F1');summary.getCell('A1').value='人员工时汇总及校验';summary.getRow(1).height=30;
 [8,16,16,16,18,18].forEach((width,i)=>{summary.getColumn(i+1).width=width;});
 const labels=['序号','人员','研发工时','部门工时','个人总工时','核对'];
 labels.forEach((v,i)=>summary.getCell(2,i+1).value=v);
 names.forEach((name,i)=>{const r=i+3,rd=result.days.filter(d=>d.person===name).reduce((sum,d)=>sum+d.rd,0),dept=result.personTotals[name]!;
  summary.getCell(r,1).value=i+1;summary.getCell(r,2).value=name;summary.getCell(r,3).value=rd;
  summary.getCell(r,4).value={formula:personDepartmentFormula(s.getColumn(totalCol).letter,first,last,r),result:dept};
  summary.getCell(r,5).value={formula:`SUM(C${r}:D${r})`,result:rd+dept};summary.getCell(r,6).value=result.issues.some(x=>x.person===name)?'待核对':'计算通过';
 });
 const end=names.length+3;summary.getCell(end,2).value='合计';for(const col of ['C','D','E']){let sum=0;for(let r=3;r<end;r++){const c=summary.getCell(`${col}${r}`);sum+=Number(c.formula?c.result:c.value);}summary.getCell(`${col}${end}`).value={formula:`SUM(${col}3:${col}${end-1})`,result:sum};}
 for(let r=2;r<=end;r++){summary.getRow(r).height=24;for(let c=1;c<=6;c++){const cell=summary.getCell(r,c);cell.style=structuredClone(cell.style);cell.alignment={horizontal:r===2||c<=2?'center':'right',vertical:'middle',wrapText:true};cell.font={name:'宋体',size:11,bold:r===2||r===end};cell.border={top:{style:'thin'},bottom:{style:'thin'},left:{style:'thin'},right:{style:'thin'}};}}
 summary.pageSetup.printArea=`A1:F${end}`;
 summary.pageSetup.fitToPage=true;summary.pageSetup.fitToWidth=1;summary.pageSetup.fitToHeight=1;
 return {row:footer,added};
}

export function fillDepartmentBook(book:ExcelJS.Workbook,layout:ReturnType<typeof departmentLayout>,result:Calculation,month:string,
 shifts:Awaited<ReturnType<typeof prepareDepartmentBook>>,currentRules:boolean){
 const totals=new Map<string,Map<string,number[]>>();
 for(const day of result.days){
  let person=totals.get(day.person);
  if(!person){person=new Map();totals.set(day.person,person);}
  const hours=person.get(day.project)??Array<number>(31).fill(0);
  const index=Number(day.date.slice(8))-1;
  hours[index]=(hours[index]??0)+day.department;
  person.set(day.project,hours);
 }
 const {sheet,totalCol}=layout;
 for(const r of layout.rows){
  const hours=totals.get(r.person)?.get(r.project)??[];
  for(let d=1;d<=31;d++)sheet.getCell(r.row,8+d).value=hours[d-1]||null;
  sheet.getCell(r.row,totalCol).value={formula:`SUM(I${r.row}:${sheet.getColumn(totalCol-1).letter}${r.row})`,result:hours.reduce((a,b)=>a+b,0)};
 }
 if(currentRules)refreshResearchRows(layout,result);
 shifts.footer=refreshTimesheetSummary(book,layout,result,monthDays(month),shifts);
 return reconcileTemplateFormulas(book,shifts);
}
