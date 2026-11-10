// ExcelJS moves cells on insert, but does not migrate Excel formula references.
// Keep the supported language deliberately small. A retained formula outside it
// is identified by worksheet, destination cell and source expression in the draft.
import type ExcelJS from 'exceljs';
import type {departmentLayout,Issue} from './timesheets.ts';

type Layout=ReturnType<typeof departmentLayout>;
interface SourceFormula {
    sheet:ExcelJS.Worksheet; row:number; col:number; formula:string; special:boolean; conflict?:string; untouched?:boolean;
}
interface TemplateLayoutChanges {
    sheet:ExcelJS.Worksheet; firstRow:number; afterRow:number; extraRows:number;
    totalCol:number; extraCols:number; formulas:SourceFormula[]; originalFooter?:number; summary?:ExcelJS.Worksheet; originalNames:string[]; footer?:{row:number; added:boolean};
}
export function departmentFooterFormula(letter:string,first:number,last:number){
    const kinds=`$D$${first}:$D$${last}`,values=`${letter}${first}:${letter}${last}`;
    return `SUMIF(${kinds},"部门工时",${values})+SUMIF(${kinds},"服务工时",${values})`;
}
export function isDepartmentFooter(row:ExcelJS.Row,layout:Layout,first:number,last:number){
    const {sheet,totalCol}=layout;
    if(!['合计','总计','部门工时合计'].includes(row.getCell(3).text.trim()))return false;
    if(row.getCell(totalCol).formula!==departmentFooterFormula(sheet.getColumn(totalCol).letter,first,last))return false;
    let exact=true;
    row.eachCell(cell=>{
        const col=Number(cell.col);
        if(col!==3&&!(col>=9&&col<=totalCol&&cell.formula===departmentFooterFormula(sheet.getColumn(col).letter,first,last)))exact=false;
    });
    return exact;
}
export function personDepartmentFormula(col:string,first:number,last:number,personRow:number){
    const detail="'工时明细表（填写）'!";
    return `SUMIFS(${detail}$${col}$${first}:$${col}$${last},${detail}$C$${first}:$C$${last},B${personRow},${detail}$D$${first}:$D$${last},"<>研发工时")`;
}
const summaryHeaders=['序号','人员','研发工时','部门工时','个人总工时','核对'];

// Reuse only the exact output layout. An additional note, replaced formula,
// altered footer, or independently supplied summary stays in its original sheet.
export function managedPersonnelSummary(book:ExcelJS.Workbook,layout:Layout){
    const first=Math.min(...layout.rows.map(r=>r.row)),last=Math.max(...layout.rows.map(r=>r.row));
    return book.worksheets.find(sheet=>{
        if(!sheet.name.startsWith('人员工时汇总'))return false;
        if(!sheet.actualRowCount)return true;
        if(sheet.getCell('A1').text!=='人员工时汇总及校验'||!summaryHeaders.every((label,i)=>sheet.getCell(2,i+1).text===label))return false;
        const end=sheet.lastRow?.number??0;
        if(end<4||sheet.getCell(end,2).text!=='合计'||sheet.getCell(end,1).value!=null||sheet.getCell(end,6).value!=null)return false;
        let extra=false;
        sheet.eachRow(row=>row.eachCell(c=>{if(Number(c.col)>6 || c.note)extra=true;}));
        if(extra)return false;
        const totals=[0,0,0],seen=new Set<string>();
        // Require the original formulas, row identities and mutually consistent
        // caches. In particular, a pasted number in place of a footer formula
        // is a user edit and must survive on the original worksheet.
        for(let r=3;r<end;r++){
            const row=sheet.getRow(r),name=row.getCell(2).value,rd=row.getCell(3).value,dept=row.getCell(4).result,all=row.getCell(5).result;
            if(row.getCell(1).value!==r-2||typeof name!=='string'||!name.trim()||seen.has(name)||typeof rd!=='number'||typeof dept!=='number'||all!==rd+dept
                ||row.getCell(4).formula!==personDepartmentFormula(layout.sheet.getColumn(layout.totalCol).letter,first,last,r)||row.getCell(5).formula!==`SUM(C${r}:D${r})`
                ||!['计算通过','待核对'].includes(row.getCell(6).text))return false;
            seen.add(name);
            totals[0]!+=rd;totals[1]!+=dept;totals[2]!+=rd+dept;
        }
        return ['C','D','E'].every((col,i)=>{
            const cell=sheet.getCell(col+end);
            return cell.formula===`SUM(${col}3:${col}${end-1})`&&cell.result===totals[i];
        });
    });
}

// A self-contained, untouched worksheet may retain its own ordinary formulas
// and caches: none of its inputs moved or changed. Dynamic / named references
// cannot establish that isolation.
const safeFunctions=new Set(['SUM','SUMIF','SUMIFS','AVERAGE','MIN','MAX','COUNT','COUNTA','COUNTIF','COUNTIFS','IF','IFERROR','AND','OR','NOT','ABS','ROUND','ROUNDUP','ROUNDDOWN','INT','LEN','LEFT','RIGHT','MID','TEXT','DATE','YEAR','MONTH','DAY','WEEKDAY']);
function purelyLocal(formula:string){
    const tokens=formula.replace(/"(?:[^"]|"")*"/g,'').replace(/\$?[A-Z]{1,3}\$?[1-9]\d*(?![A-Z0-9_.])/gi,'').replace(/[A-Z][A-Z0-9_.]*(?=\s*\()/gi,name=>safeFunctions.has(name.toUpperCase())?'':name);
    return /^[\s.,0-9+*()/:<>=&%^\-]*$/.test(tokens);
}

export function captureTemplateFormulas(book:ExcelJS.Workbook,layout:Layout,people:string[]|undefined,projects:string[]|undefined,refreshResearch:boolean):TemplateLayoutChanges{
    const formulas:SourceFormula[]=[],departmentRows=new Map(layout.rows.map(r=>[r.row,r]));
    const summary=managedPersonnelSummary(book,layout);
    const originalNames=summary?.actualRowCount?(summary.getRows(3,summary.lastRow!.number-3)??[]).map(r=>r.getCell(2).text):[];
    const firstRow=Math.min(...layout.rows.map(r=>r.row)),afterRow=Math.max(...layout.rows.map(r=>r.row))+1;
    let originalFooter:number|undefined;
    layout.sheet.eachRow(r=>{if(r.number>=afterRow&&originalFooter===undefined&&isDepartmentFooter(r,layout,firstRow,afterRow-1))originalFooter=r.number;});
    for(const sheet of book.worksheets){
        if(sheet===summary)continue;
        const independent=sheet!==layout.sheet&&sheet.name!=='封面';
        let localOnly=independent;
        const original:SourceFormula[]=[];
        sheet.eachRow(row=>{
            const detail=sheet===layout.sheet,dept=detail?departmentRows.get(row.number):undefined;
            const research=detail&&row.getCell(4).text.trim()==='研发工时';
            const footer=detail&&row.number===originalFooter;
            row.eachCell(cell=>{
                if(cell.isMerged&&cell.master.address!==cell.address)return;
                const value=cell.value as (ExcelJS.CellFormulaValue & {shareType?:string})|null;
                const formula=cell.formula;
                if(!formula)return;
                if(!purelyLocal(formula))localOnly=false;
                const col=Number(cell.col),managedDates=col>=9&&col<=layout.totalCol;
                const n=row.number;
                if((dept||research&&refreshResearch)&&col===layout.totalCol&&formula.replace(/\$/g,'').toUpperCase()===`SUM(I${n}:${sheet.getColumn(col-1).letter}${n})`)return;
                if(footer&&managedDates)return;
                if(detail&&n===layout.headerRow+1&&col<layout.totalCol&&col>=9){
                    // Accept only recognized weekday formulas; unrelated formulas in
                    // the same cells still need review.
                    if(new RegExp('^TEXT\\(\\$?'+sheet.getColumn(col).letter+'\\$?'+layout.headerRow+',"(?:aaa|aaaa|ddd|dddd)"\\)$','i').test(formula))return;
                }
                const overwritten=dept&&((people&&!people.includes(dept.person))||(projects&&!projects.includes(dept.project))||managedDates)
                    ||research&&refreshResearch||footer&&managedDates||detail&&managedDates&&[layout.headerRow,layout.headerRow+1].includes(n)
                    ||sheet.name==='封面'&&['C8','E8'].includes(cell.address);
                original.push({sheet,row:n,col,formula,special:value?.shareType==='array',conflict:overwritten?'原式占用必须按本次输入重填的位置':undefined});
            });
        });
        if(localOnly)for(const f of original)f.untouched=true;
        for(const f of original)formulas.push(f);
    }
    // Resolve all follower formulas before replacing their masters.
    for(const f of formulas){
        const c=f.sheet.getCell(f.row,f.col);
        if(!f.special&&!f.untouched)c.value={formula:f.formula,result:c.result};
    }
    return {sheet:layout.sheet,firstRow,afterRow,originalFooter,summary,originalNames,
        extraRows:0,totalCol:layout.totalCol,extraCols:40-layout.totalCol,formulas};
}
interface Ref {sheet:ExcelJS.Worksheet; prefix:string; col:number; row:number; absCol:string; absRow:string}
interface Term {from:Ref; to?:Ref}
interface Parsed {sum:boolean; terms:Term[]}
const refPattern=/(?:(?:'((?:[^']|'')+)'|([\p{L}\p{N}_\.]+))!)?(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)/iuy;
function readRef(src:string,index:number,book:ExcelJS.Workbook,defaultSheet:ExcelJS.Worksheet){
    refPattern.lastIndex=index;
    const m=refPattern.exec(src);
    if(!m)throw Error('只支持单元格引用和 SUM 数值区域');
    const name=m[1]?.replace(/''/g,"'")??m[2];
    const sheet=name===undefined?defaultSheet:book.worksheets.find(s=>s.name.toLowerCase()===name.toLowerCase());
    if(!sheet)throw Error('未找到公式引用的工作表');
    const col=[...m[4]!.toUpperCase()].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
    const row=Number(m[6]);
    if(col>16384||row>1048576)throw Error('单元格超出 Excel 范围');
    const prefix=name===undefined?'':m[0].slice(0,m[0].lastIndexOf('!')+1);
    return {ref:{sheet,prefix,col,row,absCol:m[3]!,absRow:m[5]!},end:refPattern.lastIndex};
}
function parse(formula:string,book:ExcelJS.Workbook,sheet:ExcelJS.Worksheet):Parsed{
    const src=formula.trim(),start=/^SUM\s*\(/i.exec(src),sum=!!start;
    let i=start?.[0].length??0;
    const spaces=()=>{while(/\s/.test(src[i]??'!'))i++;};
    const terms:Term[]=[];
    do{
        spaces();const from=readRef(src,i,book,sheet);i=from.end;spaces();
        const term:Term={from:from.ref};
        if(sum&&src[i]===':'){
            i++;spaces();const to=readRef(src,i,book,from.ref.sheet);i=to.end;term.to=to.ref;spaces();
            if(to.ref.sheet!==from.ref.sheet)throw Error('不支持跨工作表的三维区域');
            if(to.ref.row<from.ref.row||to.ref.col<from.ref.col)throw Error('倒序区域请改为从左上到右下的引用');
        }
        terms.push(term);
        if(!sum||src[i]!==',')break;
        i++;
    }while(i<src.length);
    if(sum&&src[i++]!==')'||src.slice(i).trim())throw Error('只支持单元格引用和 SUM 数值区域');
    return {sum,terms};
}
function position(sheet:ExcelJS.Worksheet,row:number,col:number,s:TemplateLayoutChanges){
    if(sheet!==s.sheet)return {row,col};
    return {row:row+(row>=s.afterRow?s.extraRows:0), col:col+(col>=s.totalCol?s.extraCols:0)};
}
function reference(r:Ref){
    let n=r.col,letter='';
    while(n>0){n--;letter=String.fromCharCode(65+n%26)+letter;n=Math.floor(n/26);}
    return r.prefix+r.absCol+letter+r.absRow+r.row;
}
function migrate(term:Term,changes:TemplateLayoutChanges){
    const from=term.from,to=term.to;
    // Person rows follow their original owner. The old total follows the new
    // total. A partial multi-person range has no unambiguous new boundary.
    if(from.sheet===changes.summary){
        const newEnd=changes.summary.lastRow?.number??0;
        const currentNames=(changes.summary.getRows(3,Math.max(0,newEnd-3))??[]).map(r=>r.getCell(2).text);
        const originalNames=changes.originalNames,oldEnd=originalNames.length?originalNames.length+3:0;
        if(originalNames.length===currentNames.length&&originalNames.every((n,i)=>n===currentNames[i]))return;
        if(to&&from.row!==to.row){
            if(originalNames.length&&from.row===3&&to.row===oldEnd-1){to.row=newEnd-1;return;}
            if(to.row>=3&&from.row<=Math.max(newEnd,oldEnd))throw Error('人员汇总名单变化，局部跨行区域须重新确认');
        }
        for(const ref of [from,...(to?[to]:[])]){
            if(originalNames.length&&ref.row===oldEnd){ref.row=newEnd;continue;}
            if(ref.row>=3&&ref.row<oldEnd){
                const index=currentNames.indexOf(originalNames[ref.row-3]!);
                if(index<0)throw Error('所引用的原汇总人员不在本次名单内');
                ref.row=index+3;
            }else if(ref.row>oldEnd&&ref.row<=newEnd)throw Error('原空白汇总位置现已被新名单占用');
        }
        return;
    }
    if(from.sheet!==changes.sheet)return;
    const start=position(from.sheet,from.row,from.col,changes);
    if(to){
        const end=position(to.sheet,to.row,to.col,changes);
        // Include inserted projects/dates when a range covered the complete original
        // project/date block and ended exactly at its outer edge.
        if(changes.extraRows&&to.row===changes.afterRow-1&&to.col>=9){
            if(from.row>changes.firstRow)throw Error('局部小计止于新增项目行边缘，须明确哪些项目属于该小计');
            end.row+=changes.extraRows;
        }
        if(from.col<=9&&to.col===changes.totalCol-1)end.col+=changes.extraCols;
        Object.assign(to,end);
    }
    Object.assign(from,start);
}

export function reconcileTemplateFormulas(book:ExcelJS.Workbook,changes:TemplateLayoutChanges):Issue[]{
    const issues:Issue[]=[];
    type Job={cell:ExcelJS.Cell; source:SourceFormula; parsed?:Parsed; formula:string; reason?:string; state?:'busy'|'done'|'failed'};
    const jobs=new Map<ExcelJS.Cell,Job>();
    function failure(job:Job,reason:string){
        job.state='failed';
        const {cell,source}=job;
        issues.push({code:'TEMPLATE_FORMULA',person:'',date:'',
            message:`模板公式 ${source.sheet.name}!${cell.address}（${source.formula}）无法安全核对：${reason}。请修改模板副本后重新导入。`});
        if(!source.special&&!source.conflict)cell.value={formula:job.formula};
    }
    for(const source of changes.formulas){
        const p=position(source.sheet,source.row,source.col,changes),cell=source.sheet.getCell(p.row,p.col);
        const job:Job={cell,source,formula:source.formula};
        jobs.set(cell,job);
        try{
            if(source.conflict)throw Error(source.conflict);
            if(source.special)throw Error('数组公式需要人工处理');
            const parsed=parse(source.formula,book,source.sheet);
            for(const term of parsed.terms){
                migrate(term,changes);
                const a=term.from,b=term.to??a;
                const footer=changes.footer;
                if(footer&&a.sheet===changes.sheet&&a.row<=footer.row&&footer.row<=b.row&&a.col<=40&&b.col>=9){
                    if(footer.added)throw Error('引用覆盖新增部门合计行，请明确原合计的明细范围');
                    if(a.row<changes.afterRow+changes.extraRows&&parsed.sum)throw Error('原合计同时含明细和部门合计，请排除重复加总');
                }
            }
            const args=parsed.terms.map(t=>reference(t.from)+(t.to?':'+reference(t.to):'')).join(',');
            job.formula=parsed.sum?'SUM('+args+')':args;
            job.parsed=parsed;
        }catch(error){job.reason=(error as Error).message;if(!source.untouched)failure(job,job.reason);}
    }
    let visits=0;
    function evaluate(job:Job,depth:number):void{
        if(job.state==='done')return;
        if(job.state==='failed')throw Error('依赖的模板公式尚未核对');
        if(job.state==='busy'||depth>128)throw Error('存在循环引用或引用层数过多');
        job.state='busy';
        try{
            if(job.reason)throw Error(job.reason);
            const parsed=job.parsed!;
            let total=0,result:ExcelJS.CellValue=null;
            for(const {from,to} of parsed.terms){
                const sheet=from.sheet,end=to??from;
                const lastRow=Math.min(sheet.rowCount,Math.max(from.row,end.row));
                const lastCol=Math.min(sheet.columnCount,Math.max(from.col,end.col));
                for(let r=Math.min(from.row,end.row);r<=lastRow;r++)for(let c=Math.min(from.col,end.col);c<=lastCol;c++){
                    if(++visits>2000000)throw Error('公式依赖区域超过可核对范围');
                    const cell=sheet.getCell(r,c);
                    if(cell.isMerged&&cell.master.address!==cell.address)continue;
                    const dep=jobs.get(cell);
                    if(dep)evaluate(dep,depth+1);
                    if(cell.formula&&cell.result==null)throw Error('引用的公式缺少可验证的结果');
                    const value=cell.formula?cell.result:cell.value;
                    if(value!=null&&typeof value==='object'&&!(value instanceof Date))throw Error('引用了错误值或非标量');
                    if(value instanceof Date)throw Error('引用了日期，请核对日期和工时列');
                    if(parsed.sum){
                        if(typeof value==='number')total+=value;
                    }
                    else result=value??0;
                }
            }
            if(!Number.isFinite(total))throw Error('合计超出可核对的数值范围');
            job.cell.value={formula:job.formula,result:(parsed.sum?total:result??0) as ExcelJS.CellFormulaValue['result']};
            job.state='done';
        }catch(error){failure(job,(error as Error).message);throw error;}
    }
    for(const job of jobs.values())if(!job.state&&!job.source.untouched){try{evaluate(job,0);}catch{/* Recorded with the failing cell. */}}
    return issues;
}
