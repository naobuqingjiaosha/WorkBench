import ExcelJS from 'exceljs';

// Entirely synthetic. The source template deliberately has 30 day columns while
// the example is a leap February. Nobody in a template is implicitly in scope.
export async function syntheticTimesheets() {
    const template = new ExcelJS.Workbook();
    const sheet = template.addWorksheet('工时明细表（填写）');
    const projects = ['合成甲组', '合成乙组', '合成丙组'];
    const people = ['测试人员甲', '测试人员乙'];
    sheet.getCell('A1').value='合成部门项目工时对账';
    sheet.mergeCells('A1:L1');
    sheet.getCell('C3').value='人员';sheet.getCell('D3').value='工时类型';sheet.getCell('E3').value='正式项目';
    for (const c of [3,4,5])sheet.getColumn(c).width=16;
    for(let c=9;c<=39;c++)sheet.getColumn(c).width=5;
    for (let d = 1; d <= 30; d++) sheet.getCell(3, 8 + d).value = d;
    for (const [index, person] of people.entries()) {
        const row = 5 + index;
        sheet.getCell(row, 3).value = person;
        sheet.getCell(row, 4).value = '部门工时';
        sheet.getCell(row, 5).value = projects[0];
        sheet.getCell(row, 9).value = 99;
        sheet.getCell(row, 39).value = {formula: `SUM(I${row}:AL${row})`, result: 99};
    }
    for (const [index,person] of people.entries()) {
        const row=7+index;sheet.getCell(row,3).value=person;sheet.getCell(row,4).value='研发工时';
        sheet.getCell(row,5).value='上期合成研发项目';sheet.getCell(row,6).value='上期合成合同';
        sheet.getCell(row,9).value=99;sheet.getCell(row,39).value={formula:`SUM(I${row}:AL${row})`,result:99};
    }
    sheet.pageSetup.orientation = 'landscape';
    sheet.pageSetup.fitToPage = true;
    sheet.pageSetup.fitToWidth = 1;
    sheet.pageSetup.fitToHeight = 1;
    template.addWorksheet('人员工时汇总');
    const rd = new ExcelJS.Workbook();
    const rdSheet = rd.addWorksheet('工时明细表（填写）');
    const attendance = new ExcelJS.Workbook();
    const attSheet = attendance.addWorksheet('合成考勤');
    attSheet.getCell(1, 1).value = '姓名';
    for (let d = 1; d <= 29; d++) {
        rdSheet.getCell(3, 8 + d).value = d;
        attSheet.getCell(1, 1 + d).value = d;
        // Only days 2 and 29 are confirmed payroll dates. Day 29 has an explicitly named project.
        rdSheet.getCell(5, 8 + d).value = d === 2 ? 1 : 0;
        rdSheet.getCell(6, 8 + d).value = d === 2 ? 6 : 0;
        for (const r of [2, 3]) attSheet.getCell(r, 1 + d).value = d === 29 ? '驻场 合成丙组' : d === 2 ? '正常' : '休息';
    }
    for (const [index, person] of people.entries()) {
        rdSheet.getCell(5 + index, 3).value = person;
        attSheet.getCell(2 + index, 1).value = person;
    }
    const report=new ExcelJS.Workbook();
    report.addWorksheet('空页');
    const reportSheet=report.addWorksheet('当期项目');
    reportSheet.addRow(['2028年2月项目月报']);
    reportSheet.addRow(['项目名称','项目建设单位','本月完成情况','累计完成比例']);
    for(const project of projects.slice(1))reportSheet.addRow([project,'合成单位','当期资料核对','100%']);
    const bytes = async (book: ExcelJS.Workbook) => Buffer.from(await book.xlsx.writeBuffer());
    return {month: '2028-02', people, projects, template: await bytes(template), rd: await bytes(rd), attendance: await bytes(attendance),report:await bytes(report)};
}
