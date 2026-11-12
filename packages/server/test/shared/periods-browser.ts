import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import PizZip from 'pizzip';
import {withBrowserPage} from './browser-fixture.ts';

await withBrowserPage(async(page,base)=>{
let token='';
async function request(path:string,method='GET',body?:object|FormData){
  const form=body instanceof FormData;
  const response=await fetch(base+path,{method,headers:{'x-workbench-token':token,...body&&!form?{'content-type':'application/json'}:{}},body:form?body:body?JSON.stringify(body):undefined});
  const result=await response.json();assert.ok(response.ok,result.error?.message||path);return result.data;
}
function wordTemplate(title:string,lines:string[]){
  const zip=new PizZip(),word='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const paragraphs=[title,...lines].map((line,i)=>'<w:p><w:pPr><w:spacing w:after="180"/></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="'+(i===0?36:24)+'"/></w:rPr><w:t>'+line+'</w:t></w:r></w:p>').join('');
  zip.file('word/document.xml',`<w:document xmlns:w="${word}"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`);
  return zip.generate({type:'uint8array'});
}
  token=(await request('/api/session')).token;
  const types=(await request('/api/work-types')).items;
  const type=(code:string)=>types.find((t:{code:string})=>t.code===code);
  const year=new Date().getFullYear()-1;
  async function setup(code:string,name:string,first:string,lines?:string[]){
    const wt=type(code),templateIds:number[]=[];
    if(lines){
      const form=new FormData();form.append('name',name);form.append('workTypeId',String(wt.id));
      const template=wordTemplate(name,lines);
      if(process.env.PERIOD_SAMPLE_DIR){
        const inputs=join(process.env.PERIOD_SAMPLE_DIR,'试用输入');mkdirSync(inputs,{recursive:true});
        writeFileSync(join(inputs,name+'.docx'),template,{flag:'wx'});
      }
      form.append('file',new Blob([new Uint8Array(template)]),name+'.docx');
      templateIds.push((await request('/api/templates/upload','POST',form)).items[0].template.id);
    }
    const work=await request('/api/workbenches','POST',{workTypeId:wt.id,publishedConfigId:wt.published_config_id,name,firstPeriod:first,templateIds});
    const p=(await request(`/api/workbenches/${work.id}/periods`)).items.find((p:{report_period:string})=>p.report_period===first);
    return {work,p};
  }
  async function openPeriod(scope:{work:{id:number};p:{id:number}}){
    await page.goto(base+`/#/workbench?id=${scope.work.id}&periodId=${scope.p.id}`);
    await page.locator('.period-workspace').waitFor();
  }
  async function generateAndRead(name:string,expected:string[],scope:{work:{id:number};p:{id:number}},sample:string){
    await page.getByRole('button',{name:name+' · 生成',exact:true}).click();
    const modal=page.getByRole('dialog').last();
    await modal.getByRole('button',{name:'保存草稿',exact:true}).click();
    const link=page.locator('.result-row').getByRole('link',{name:'下载',exact:true}).first();
    await link.waitFor();
    const artifactId=Number((await link.getAttribute('href')).split('/')[3]);
    const {artifact:record}=await request('/api/artifacts/'+artifactId);
    assert.equal(record.workbench_id,scope.work.id);assert.equal(record.work_period_id,scope.p.id);assert.equal(record.is_final,0);
    const downloading=page.waitForEvent('download');
    await link.click();const download=await downloading;
    const data=readFileSync(await download.path());
    const xml=new PizZip(data).file('word/document.xml')!.asText();
    for(const value of expected)assert.ok(xml.includes(value),'生成文书缺少 '+value);
    assert.ok(!xml.includes('{报告期}'));
    const outputPath=process.env.PERIOD_SAMPLE_DIR;
    if(outputPath)writeFileSync(join(outputPath,sample+'.docx'),data);
    await page.reload();await link.waitFor();assert.equal((await link.getAttribute('href')).split('/')[3],String(artifactId));
  }

  // New generic reminder through the same form used by a person.
  await page.goto(base+'/#/workbench?create=1');
  assert.equal(await page.getByRole('button',{name:'创建',exact:true}).count(),0);
  await page.getByRole('button',{name:/行政管理工作/}).click();
  await page.getByLabel('工作类型',{exact:false}).first().selectOption(String(type('admin').id));
  await page.getByPlaceholder('例如：清廉工程月度监督检查').fill('合成周期提醒');
  await page.getByLabel('到期日号',{exact:false}).fill('32');
  assert.equal(await page.getByRole('button',{name:'创建',exact:true}).isDisabled(),true);
  await page.getByLabel('到期日号',{exact:false}).fill('28');
  await page.getByLabel('提前提醒天数',{exact:false}).fill('31');
  await page.getByRole('button',{name:'创建',exact:true}).click();
  const done=page.getByRole('button',{name:'确认本次提醒已处理',exact:true});await done.waitFor();
  const reminderUrl=page.url();
  await page.goto(base+'/#/dashboard');
  await page.locator('#home-inbox').getByText('合成周期提醒',{exact:true}).waitFor();
  await page.goto(reminderUrl);await done.click();
  await page.getByText(/本次提醒已处理，下次提醒/).waitFor();

  const meeting=await setup('safety-report','安全例会纪要',year+'-10',['办理期次 {报告期}','会议记录 {业务内容}']);
  const periods=(await request('/api/workbenches/'+meeting.work.id+'/periods')).items;
  const another=periods.find((item:{id:number})=>item.id!==meeting.p.id)!;
  await page.goto(base+'/#/workbench');
  const list=page.locator('.workbench-list'),filter=list.getByPlaceholder('搜索工作名称、编号、单位');
  await list.getByRole('row').filter({hasText:'合成周期提醒'}).getByText(/周期提醒/).last().waitFor();
  await filter.fill('安全例会纪要');
  const row=list.getByRole('row').filter({hasText:'安全例会纪要'});
  await row.getByText('待办期次截止 '+meeting.p.due_date,{exact:true}).waitFor();
  await row.getByRole('button',{name:'继续办理'}).click();
  const select=page.locator('.period-panel > .card-body > .row select');
  await page.waitForURL('**/workbench?id='+meeting.work.id+'&periodId='+meeting.p.id);
  await page.locator('.period-workspace').waitFor();
  assert.equal(await select.inputValue(),String(meeting.p.id));
  await select.selectOption(String(another.id));
  await page.waitForURL('**/workbench?id='+meeting.work.id+'&periodId='+another.id);
  await page.reload();await page.locator('.period-workspace').waitFor();
  assert.equal(await select.inputValue(),String(another.id));
  await page.goBack();await select.locator('option:checked[value="'+meeting.p.id+'"]').waitFor({state:'attached'});
  await page.goForward();await select.locator('option:checked[value="'+another.id+'"]').waitFor({state:'attached'});
  await page.goBack();await page.goBack();await list.getByRole('button',{name:'继续办理'}).first().waitFor();
  assert.equal(await filter.inputValue(),'安全例会纪要');
  await page.setViewportSize({width:390,height:844});
  const bounds=await row.getByRole('button',{name:'继续办理'}).boundingBox();
  assert.ok(bounds && bounds.x>=0 && bounds.x+bounds.width<=390,'窄屏主操作应在首屏宽度内');
  const info=row.locator('.work-list-mobile-info');
  await info.locator('summary').click();assert.equal(await info.getAttribute('open'),'');
  await info.locator('summary').click();assert.equal(await info.getAttribute('open'),null);
  await page.setViewportSize({width:1366,height:850});
  await row.getByRole('button',{name:'继续办理'}).click();
  const content=page.getByPlaceholder('填写工作安排、实际情况、会议记录或拟稿要点…');
  await content.fill('合成例会 已核对演练名单，后续日期待定。');
  // A second editor saves after this page loaded. Keep both values visible until the user chooses.
  await request('/api/periods/'+meeting.p.id,'PUT',{content:'另一入口的合成记录',expected:{content:''}});
  await page.getByRole('button',{name:'保存业务内容',exact:true}).click();
  await page.getByText('另一入口的合成记录',{exact:true}).waitFor();
  assert.ok((await content.inputValue()).includes('后续日期待定'));
  await page.getByRole('button',{name:'保留我的输入，继续核对',exact:true}).click();
  await page.getByRole('button',{name:'保存业务内容',exact:true}).click();
  await page.getByText('业务内容已保存',{exact:true}).waitFor();
  await page.getByText('参考资料与附件',{exact:false}).first().click();
  await page.getByLabel('添加参考资料',{exact:true}).setInputFiles({name:'合成议程.txt',mimeType:'text/plain',buffer:Buffer.from('合成议程：核对演练名单')});
  await page.getByText('合成议程.txt',{exact:true}).waitFor();
  await generateAndRead('安全例会纪要',[year+'-10','合成例会','后续日期待定'],meeting,'safety-minutes');

  const monthly=await setup('integrity-monthly-inspection','合成月度监督',year+'-10');
  await page.goto(base+`/#/workbench?id=${monthly.work.id}&periodId=${meeting.p.id}`);
  await page.getByText('当前工作没有链接指定的期次，请重新选择报告期。',{exact:true}).waitFor();
  assert.equal(await page.locator('.period-workspace').count(),0);
  await openPeriod(monthly);
  await page.getByText('草稿 0 份，已确认 0 次',{exact:false}).last().waitFor();
  await page.getByText('检查草稿、已确认记录与单次表册',{exact:true}).click();
  await page.getByRole('button',{name:'新建检查记录',exact:true}).click();
  await page.getByText(/草稿 1 份，已确认 0 次/).last().waitFor();
  assert.equal(await page.getByRole('link',{name:'在工作页面继续编辑'}).count(),0);
  await page.getByLabel('检查项目',{exact:false}).first().fill('合成项目');
  await page.getByLabel('检查重点',{exact:false}).first().fill('核对合成标识');
  // Commit the actual write, then drop only its acknowledgement before reopening.
  const draftPath='/api/periods/'+monthly.p.id+'/drafts';
  const partial=(await request(draftPath)).drafts[0];
  const saveUrl=base+draftPath+'/'+partial.id;
  await page.route(saveUrl,async (route:any)=>{
    const response=await route.fetch();
    assert.equal(response.status(),200);
    await route.abort('failed');
  },{times:1});
  const lost=page.waitForEvent('requestfailed',(r:any)=>r.method()==='PUT'&&r.url()===saveUrl);
  await page.getByRole('button',{name:'保存草稿',exact:true}).click();
  await lost;
  await page.reload();await page.getByText('检查草稿、已确认记录与单次表册',{exact:true}).click();
  await page.getByText('已核对上次修改已保存，已载入最新草稿。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'保存草稿',exact:true}).isDisabled(),true);
  assert.equal(await page.getByLabel('检查项目',{exact:false}).first().inputValue(),'合成项目');
  assert.equal(await page.getByRole('button',{name:'确认实际检查',exact:true}).isDisabled(),true);
  await page.getByLabel('实际检查日期（未知可留空）',{exact:false}).fill(year+'-10-15');
  await page.getByLabel('检查内容／清单',{exact:false}).fill('合成记录核对两件样品');
  await page.getByLabel('实际结果／待确认写法',{exact:false}).fill('一件标识待更换');
  await page.getByRole('button',{name:'确认实际检查',exact:true}).click();
  await page.getByRole('button',{name:'确认并登记',exact:true}).click();
  await page.getByText('已登记实际检查',{exact:true}).waitFor();

  const summary=await setup('integrity-quarter-summary','季度监督汇报',year+'-Q4',['办理期次 {报告期}','参考范围 {季度参考范围}','范围内确认检查 {范围内已确认检查次数} 次','已登记检查 {范围内已确认检查}']);
  await openPeriod(summary);
  await page.getByLabel('合成月度监督 · '+year+'-10',{exact:true}).check();
  const november=(await request(`/api/workbenches/${monthly.work.id}/periods`)).items.find((p:{report_period:string})=>p.report_period===year+'-11');
  await request('/api/periods/'+summary.p.id,'PUT',{scheduled_date:year+'-12-01',source_period_ids:[november.id]});
  await page.getByRole('button',{name:'保存安排与参考范围',exact:true}).click();
  await page.getByText('已保存范围：合成月度监督 · '+year+'-11',{exact:true}).waitFor();
  await page.getByText('本页选择：合成月度监督 · '+year+'-10',{exact:true}).waitFor();
  await page.getByRole('button',{name:'保留本页修改，继续核对',exact:true}).click();
  assert.equal(await page.getByLabel('安排日期（可选）',{exact:true}).inputValue(),year+'-12-01');
  await page.getByRole('button',{name:'保存安排与参考范围',exact:true}).click();
  await page.getByText('已保存本期安排与参考范围',{exact:true}).waitFor();
  await page.reload();
  assert.equal(await page.getByLabel('合成月度监督 · '+year+'-10',{exact:true}).isChecked(),true);
  await generateAndRead('季度监督汇报',[year+'-Q4','合成月度监督','范围内确认检查 1 次','一件标识待更换'],summary,'quarter-review');
  // Equal text with a different origin is still a real conflict. Preserve the human input.
  await openPeriod(monthly);
  await page.getByText('检查草稿、已确认记录与单次表册',{exact:true}).click();
  const subject=page.getByLabel('检查重点',{exact:false}).first();
  const human='人工补充检查重点';
  await subject.fill(human);
  const saved=(await request(draftPath)).drafts[0];
  const latestMethod='另一页已核对的方法';
  await request(draftPath+'/'+saved.id,'PUT',{revision:saved.revision,fields:{subject:human,method:latestMethod},aiFields:['subject']});
  const saveDraft=page.getByRole('button',{name:'保存草稿',exact:true});
  const review=page.getByRole('region',{name:'核对草稿修改',exact:true});
  await saveDraft.click();
  await review.getByText('已保存（AI建议）：'+human,{exact:true}).waitFor();
  await review.getByText('本页（用户输入）：'+human,{exact:true}).waitFor();
  assert.equal(await saveDraft.isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'确认实际检查',exact:true}).isDisabled(),true);
  await page.reload();await page.getByText('检查草稿、已确认记录与单次表册',{exact:true}).click();
  await review.getByText('已保存（用户输入）：'+latestMethod,{exact:true}).waitFor();
  assert.equal(await subject.inputValue(),human);
  await review.getByRole('button',{name:'保留本页修改并继续核对',exact:true}).click();
  assert.equal(await page.getByLabel('检查方法',{exact:false}).first().inputValue(),latestMethod);
  assert.equal((await request(draftPath)).drafts[0].provenance.subject,'AI建议');
  const modified=page.waitForResponse((r:any)=>r.request().method()==='PUT'&&r.url()===saveUrl);
  await saveDraft.click(); await modified;
  const resolved=(await request(draftPath)).drafts[0];
  assert.equal(resolved.provenance.subject,'用户输入');
  assert.equal(resolved.fields.subject,human);
  assert.equal(resolved.fields.method,latestMethod);
  assert.equal(resolved.provenance.method,'用户输入');
  assert.equal((await request('/api/periods/'+monthly.p.id+'/inspections')).records[0].subject,'核对合成标识');
  // Choosing the saved version discards only these local edits and performs no write.
  await subject.fill('待放弃的本页内容');
  const remote=await request(draftPath+'/'+saved.id,'PUT',{revision:resolved.revision,fields:{subject:'保留另一页已保存版本'}});
  await saveDraft.click();
  await review.getByRole('button',{name:'载入已保存版本',exact:true}).click();
  assert.equal(await subject.inputValue(),remote.fields.subject);
  assert.equal(await saveDraft.isDisabled(),true);
  assert.equal((await request(draftPath)).drafts[0].revision,remote.revision);
  // A list entry restores its page and scrolled row even after the detail is reloaded.
  const admin=type('admin');
  for(let i=0;i<36;i++)await request('/api/workbenches','POST',{workTypeId:admin.id,publishedConfigId:admin.published_config_id,
    name:'合成翻页工作 '+i,recurrence:'monthly',recurDay:8});
  await page.goto(base+'/#/workbench');
  await filter.fill('合成翻页工作');
  await list.getByRole('button',{name:'行政管理',exact:true}).click();
  await list.getByRole('button',{name:'下一页',exact:true}).click();
  await list.getByText('第 2 页 · 每页 20 项',{exact:true}).waitFor();
  const table=list.locator('.workbench-list-content');
  const openLast=table.getByRole('button',{name:'继续办理',exact:true}).last();
  await openLast.scrollIntoViewIfNeeded();
  const scrollTop=()=>table.evaluate((el:{scrollTop:number})=>el.scrollTop);
  const top=await scrollTop();
  assert.ok(top>0);
  await openLast.click();await page.locator('.work-detail').waitFor();
  await page.reload();await page.locator('.work-detail').waitFor();
  await page.goBack();
  await list.getByText('第 2 页 · 每页 20 项',{exact:true}).waitFor();
  assert.equal(await filter.inputValue(),'合成翻页工作');
  assert.ok((await list.getByRole('button',{name:'行政管理',exact:true}).getAttribute('class')).includes('selected'));
  assert.ok(Math.abs((await scrollTop())-top)<2,'浏览器返回应定位至打开工作时的列表位置');
  await openLast.click();await page.locator('.work-detail').waitFor();
  await page.reload();await page.getByRole('link',{name:'我的工作台',exact:true}).click();
  await list.getByText('第 2 页 · 每页 20 项',{exact:true}).waitFor();
  assert.equal(await filter.inputValue(),'合成翻页工作');
  assert.ok(Math.abs((await scrollTop())-top)<2,'返回列表链接应恢复原滚动位置');
  console.log('浏览器验收通过：提醒新建、通知、完成本期，例会填报、参考附件、保存下载，检查草稿重开与明确登记，季度选期、统计、Word 生成与重开。');
});
