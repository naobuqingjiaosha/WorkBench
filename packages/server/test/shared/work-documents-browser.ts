import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {EventEmitter,once} from 'node:events';
import {withBrowserPage} from './browser-fixture.ts';
import PizZip from 'pizzip';

await withBrowserPage(async (page,base)=>{
  const session=await (await fetch(base+'/api/session')).json();
  async function request(path:string,method='GET',body?:object|FormData) {
    const form=body instanceof FormData;
    const response=await fetch(base+path,{method,headers:{'x-workbench-token':session.data.token,...body&&!form?{'Content-Type':'application/json'}:{}},
      body:form?body:body?JSON.stringify(body):undefined});
    const result=await response.json();assert.ok(response.ok,result.error?.message||path);return result.data;
  }
  const missing=await fetch(base+'/api/workbenches/'+Number.MAX_SAFE_INTEGER,{method:'PUT',
    headers:{'Content-Type':'application/json','x-workbench-token':session.data.token},
    body:JSON.stringify({businessContent:'合成测试',expectedBusinessContent:''})});
  assert.equal(missing.status,404);
  assert.equal((await missing.json()).error.code,'NOT_FOUND');
  const type=(await request('/api/work-types')).items.find((t:{code:string})=>t.code==='admin');
  const template=new PizZip();
  template.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  template.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  template.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>工作正文 {业务内容}</w:t></w:r></w:p></w:body></w:document>');
  const data=new FormData();
  data.append('file',new Blob([template.generate({type:'uint8array'})]),'合成工作记录.docx');
  data.append('workTypeId',String(type.id));data.append('name','合成工作记录');
  const {items}=await request('/api/templates/upload','POST',data);
  data.set('name','补充业务模板');
  const secondTemplate=(await request('/api/templates/upload','POST',data)).items[0].template;
  const work=await request('/api/workbenches','POST',{workTypeId:type.id,publishedConfigId:type.published_config_id,name:'合成非期次工作',recurrence:'monthly',recurDay:15,templateIds:[items[0].template.id]});
  const path='/api/workbenches/'+work.id, route=base+path;
  const persisted=async ()=>(await request(path)).workbench.business_content;
  const input=page.getByPlaceholder('填写工作安排、实际情况、会议记录或拟稿要点…');
  const button=(name:string)=>page.getByRole('button',{name,exact:true});
  const open=async ()=>{
    await page.goto(base+'/#/workbench?id='+work.id);
    const panel=page.locator('.work-documents-panel');
    await panel.waitFor();
    if(!(await panel.evaluate((e:HTMLDetailsElement)=>e.open)))await panel.locator('summary').click();
    await input.waitFor();
  };
  const home=()=>page.getByRole('button',{name:'工作台首页',exact:false}).first().click();
  const failNextSave=()=>page.route(route,(r:any)=>r.fulfill({status:503,contentType:'application/json',
    body:JSON.stringify({ok:false,error:{code:'SYNTHETIC',message:'合成保存失败'}})}),{times:1});
  const A='已提交正文甲',B='继续编辑正文乙';
  await open();
  await input.fill(A);
  async function editDuringAcknowledgement(action:string,next:string){
    const signal=new EventEmitter();
    const committed=once(signal,'committed',{signal:AbortSignal.timeout(10000)});
    let respond!:()=>void;
    const unblock=new Promise<void>(done=>{respond=done;});
    await page.route(route,async (intercept:any)=>{
      const reply=await intercept.fetch();
      signal.emit('committed');await unblock;
      await intercept.fulfill({response:reply});
    },{times:1});
    try{
      await button(action).click();await committed;
      await input.fill(next);
      const response=page.waitForResponse((res:any)=>res.url()===route&&res.request().method()==='PUT');
      respond();await response;
    }finally{respond();}
  }
  await editDuringAcknowledgement('保存业务内容',B);
  assert.equal(await persisted(),A);
  assert.equal(await input.inputValue(),B);
  await home();
  const guard=page.getByRole('dialog',{name:'还有未保存的修改'});
  await guard.waitFor();
  await guard.getByRole('button',{name:'继续编辑'}).click();
  assert.equal(await input.inputValue(),B);

  // Refresh restores the unacknowledged local text; a failed write blocks generation and leaving.
  await page.reload();await open();
  assert.equal(await input.inputValue(),B);
  await failNextSave();
  await button('合成工作记录 · 生成').click();
  await page.getByRole('alert').filter({hasText:'合成保存失败'}).first().waitFor();
  assert.equal(await persisted(),A);
  assert.equal(await input.inputValue(),B);
  assert.equal(await page.getByRole('dialog').count(),0);
  await home();
  await guard.waitFor();
  await failNextSave();
  await guard.getByRole('button',{name:'保存并离开'}).click();
  await guard.getByRole('alert').filter({hasText:'合成保存失败'}).waitFor();
  assert.equal(await persisted(),A);
  assert.equal(await input.inputValue(),B);
  await guard.getByRole('button',{name:'保存并离开'}).click();
  await page.waitForURL(/#\/dashboard$/);
  assert.equal(await persisted(),B);
  await open();
  assert.equal(await input.inputValue(),B);

  // Reject a stale competing change and require explicit reconciliation before generating.
  const C='最终确认的工作正文丙',earlier='准备生成后又修改的草稿',external='另一窗口保存的文本';
  await input.fill(earlier);
  await request(path,'PUT',{businessContent:external});
  await button('合成工作记录 · 生成').click();
  await button('保留本页正文，继续核对').waitFor();
  assert.equal(await input.inputValue(),earlier);
  assert.equal(await persisted(),external);
  assert.equal(await page.getByRole('dialog').count(),0);
  await button('保留本页正文，继续核对').click();

  await editDuringAcknowledgement('合成工作记录 · 生成',C);
  await page.getByRole('alert').filter({hasText:'随后输入的修改仍待保存'}).first().waitFor();
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal((await request('/api/artifacts?workbenchId='+work.id)).items.length,0);
  assert.equal(await persisted(),earlier);
  assert.equal(await input.inputValue(),C);

  // The saved business text, normal document generation and the bytes offered for download agree.
  await button('合成工作记录 · 生成').click();
  const modal=page.getByRole('dialog').last();
  await modal.getByRole('button',{name:'保存草稿',exact:true}).click();
  const downloadLink=page.locator('.result-row').getByRole('link',{name:'下载',exact:true});
  await downloadLink.waitFor();
  assert.equal(await persisted(),C);
  const pendingDownload=page.waitForEvent('download');
  await downloadLink.click();
  const download=await pendingDownload;
  const bytes=readFileSync(await download.path());
  const xml=new PizZip(bytes).file('word/document.xml')!.asText();
  assert.ok(xml.includes('工作正文 '+C));
  assert.ok(!xml.includes(external)&&!xml.includes(B)&&!xml.includes(earlier));
  const artifacts=(await request('/api/artifacts?workbenchId='+work.id)).items;
  assert.equal(artifacts.length,1);
  assert.equal(artifacts[0].workbench_id,work.id);assert.equal(artifacts[0].work_period_id,null);
  await page.reload();await open();
  assert.equal(await input.inputValue(),C);
  await downloadLink.waitFor();
  await input.fill('明确放弃的本页修改');
  await home();
  await guard.getByRole('button',{name:'不保存离开'}).click();
  await page.waitForURL(/#\/dashboard$/);
  await open();
  assert.equal(await input.inputValue(),C);
  assert.equal(await persisted(),C);
  // Navigation saves the content and template editors once each even when both are dirty.
  const combined='一并保存的业务补充说明';
  await input.fill(combined);
  await button('选择 / 调整模板').click();
  await page.getByRole('checkbox',{name:/补充业务模板/}).check();
  const writes:string[]=[];
  const observe=(r:any)=>{if(r.method()==='PUT'&&[route,route+'/templates'].includes(r.url()))writes.push(r.url());};
  page.on('request',observe);
  await home();await guard.getByRole('button',{name:'保存并离开'}).click();
  await page.waitForURL(/#\/dashboard$/);
  page.off('request',observe);
  assert.deepEqual(writes.sort(),[route,route+'/templates'].sort());
  assert.equal(await persisted(),combined);
  assert.ok((await request(path+'/templates')).items.some((t:{id:number})=>t.id===secondTemplate.id));
  await open();
  assert.equal(await input.inputValue(),combined);
  await button('补充业务模板 · 生成').waitFor();
  if(process.env.WORK_DOCUMENT_SAMPLE_DIR){
    mkdirSync(process.env.WORK_DOCUMENT_SAMPLE_DIR,{recursive:true});
    writeFileSync(join(process.env.WORK_DOCUMENT_SAMPLE_DIR,'非期次工作正文.docx'),bytes);
  }
  console.log('非期次正文：慢回执、失败、重开、冲突核对、正文与模板一并保存通过。迟到保存未生成旧文件；实际下载 DOCX 与生成时保存的正文一致。');
});
