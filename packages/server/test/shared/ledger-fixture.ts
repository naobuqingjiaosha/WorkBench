import ExcelJS from 'exceljs';
import {createWorkbench} from '../../src/domain/service.ts';
import {get} from '../../src/db/index.ts';
import {syncPeriods} from '../../src/domain/periods.ts';

export function ledgerScopeFixture(){
  const type=get<{id:number;published_config_id:number}>("SELECT * FROM work_type WHERE code='integrity-monthly-inspection'")!;
  const first='2028-02',work=createWorkbench({name:'合成检查工作',workTypeId:type.id,publishedConfigId:type.published_config_id,firstPeriod:first});
  const period=syncPeriods(work.id,first+'-20').find(p=>p.report_period===first)!;
  return {work,period};
}

export async function ledgerBooks(headerRow=4){
  const ledger=new ExcelJS.Workbook(),s=ledger.addWorksheet('合成项目');
  if(headerRow>1)s.getCell('A1').value='合成年度工作台账';
  s.getRow(headerRow).values=['序号','时间','监督事项','监督方式','具体内容','发现问题','整改情况','备注'];
  s.getRow(headerRow+1).values=[1,'2028-02-12','合成交付核对','现场核对','已核对合成材料甲','发现合成差异','待核对','合成备注'];
  for (const [i,width] of [8,16,21,17,30,26,18,16].entries()) s.getColumn(i+1).width=width;
  s.pageSetup.orientation='landscape';s.pageSetup.printArea='A1:H'+(headerRow+1);
  const work=new ExcelJS.Workbook(),w=work.addWorksheet('工作记录表');
  for (const [i,text] of ['工作记录表','项目','日期','检查内容','检查结果'].entries())w.getCell(i+1,1).value=text;
  w.getColumn(1).width=22;w.getColumn(2).width=42;w.pageSetup.printArea='A1:B5';
  const supervision=new ExcelJS.Workbook(),t=supervision.addWorksheet('监督情况表');
  t.getCell('A1').value='合成监督情况表';
  t.getRow(5).values=['序号','项目和事项','廉政监督情况记录','发现问题','整改情况','备注'];
  for(let col=1;col<=6;col++)t.getColumn(col).width=22;
  t.pageSetup.orientation='landscape';t.pageSetup.printArea='A1:F6';
  for(const sheet of [s,w,t]){
    sheet.pageSetup.paperSize=9;sheet.pageSetup.fitToPage=true;sheet.pageSetup.fitToWidth=1;sheet.pageSetup.fitToHeight=1;
    sheet.eachRow((row,index)=>{
      row.height=index===1?32:36;
      row.eachCell(cell=>{
        cell.font={name:'Noto Sans CJK SC',size:11,bold:index===1};
        cell.alignment={vertical:'middle',wrapText:true};
        cell.border={bottom:{style:'thin',color:{argb:'FFBECADA'}}};
      });
    });
  }
  if(headerRow>1)s.mergeCells('A1:H1');
  w.mergeCells('A1:B1');t.mergeCells('A1:F1');t.mergeCells('A3:F3');t.mergeCells('A4:F4');
  return {ledger:Buffer.from(await ledger.xlsx.writeBuffer()),work:Buffer.from(await work.xlsx.writeBuffer()),supervision:Buffer.from(await supervision.xlsx.writeBuffer())};
}
