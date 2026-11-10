import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {withBrowserPage} from './browser-fixture.ts';

const suggestion='建议核对合成设备标识与领用清单。';
const handwritten='人工复核后改为核对设备领用签字。';
const modelName='synthetic-inspection-writer';
let fail = false;
let hold: Promise<void> | undefined;
let release: (() => void) | undefined;
const calls: Array<{model:string;allowed:string[];month:string}> = [];
const mock=createServer(async (req,res)=>{
  if(req.method!=='POST'||req.url!=='/v1/chat/completions') { res.writeHead(404).end(); return; }
  const chunks:Buffer[]=[];
  for await(const chunk of req) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  const context=JSON.parse(body.messages.find((message:{role:string})=>message.role==='user').content);
  calls.push({model:body.model,allowed:context.allowed,month:context.month});
  await hold;
  res.writeHead(fail ? 503 : 200,{'Content-Type':'application/json'});
  res.end(JSON.stringify(fail ? {error:{message:'合成服务暂不可用'}} : {
    choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({fields:{content:suggestion},reason:'合成建议，仅作核对参考'})}}]
  }));
});

await new Promise<void>((ok,bad)=>mock.once('error',bad).listen(0,'127.0.0.1',ok));
try {
  await withBrowserPage(async (page,base)=>{
    const session=await (await fetch(base+'/api/session')).json();
    async function api(path:string,method='GET',body?:object) {
      const response=await fetch(base+path,{method,headers:{'x-workbench-token':session.data.token,'Content-Type':'application/json'},
        body:body ? JSON.stringify(body) : undefined});
      const value=await response.json();
      assert.ok(response.ok,value.error?.message||path);
      return value.data;
    }
    const port=(mock.address() as AddressInfo).port;
    await api('/api/ai/local','PUT',{baseUrl:'http://127.0.0.1:'+port+'/v1',model:modelName});
    const type=(await api('/api/work-types')).items.find((t:{code:string})=>t.code==='integrity-monthly-inspection');
    const month=new Date().toISOString().slice(0,7);
    const work=await api('/api/workbenches','POST',{name:'合成检查草稿',workTypeId:type.id,publishedConfigId:type.published_config_id,firstPeriod:month});
    const period=(await api('/api/workbenches/'+work.id+'/periods')).items.find((p:{report_period:string})=>p.report_period===month);
    const path='/api/periods/'+period.id;
    const saved=async ()=>(await api(path+'/drafts')).drafts[0];
    const count=async ()=>(await api(path+'/inspections')).records.length;

    await page.goto(base+'/#/workbench?id='+work.id+'&periodId='+period.id);
    await page.getByText('检查草稿、已确认记录与单次表册',{exact:true}).click();
    await page.getByRole('button',{name:'新建检查记录',exact:true}).click();
    await page.getByLabel('修改范围',{exact:false}).selectOption('content');
    const request=page.getByRole('button',{name:'请助手起草／修改',exact:true});
    const apply=page.getByRole('button',{name:'采用 1 项到编辑区',exact:true});
    const save=page.getByRole('button',{name:'保存草稿',exact:true});
    const content=page.getByLabel('检查内容／清单',{exact:false}).first();
    const version=(await saved()).revision;
    await request.click();
    await apply.waitFor();
    assert.equal(await page.getByLabel('建议（可编辑）',{exact:false}).inputValue(),suggestion);
    assert.equal(await content.inputValue(),'');
    assert.equal((await saved()).revision,version);
    assert.equal(await count(),0);
    await apply.click();
    await page.getByText('已采用到编辑区，尚未保存。',{exact:true}).waitFor();
    assert.equal(await content.inputValue(),suggestion);
    assert.equal((await saved()).fields.content,'');
    const savedResponse=page.waitForResponse((r:any)=>r.request().method()==='PUT'&&r.url().includes(path+'/drafts/'));
    await save.click(); await savedResponse;
    const draft=await saved();
    assert.equal(draft.provenance.content,'AI建议');
    assert.equal(draft.fields.content,suggestion);
    assert.equal(draft.fields.inspection_date,'');
    assert.equal(draft.fields.result,'');
    assert.equal(await count(),0);

    // Edit while a later model response is in flight. Applying the old text must preserve the local input.
    hold=new Promise<void>(ok=>{release=ok;});
    const inFlight=once(mock,'request',{signal:AbortSignal.timeout(7500)});
    await request.click();
    await inFlight;
    await content.fill(handwritten);
    release!();
    await apply.waitFor();
    await apply.click();
    await page.getByText(/草稿或来源已变化，请重新请求建议/).waitFor();
    assert.equal(await content.inputValue(),handwritten);

    fail=true;
    await request.click();
    await page.getByText(/AI建议尚未生成/).waitFor();
    assert.equal(await content.inputValue(),handwritten);
    const updated=page.waitForResponse((r:any)=>r.request().method()==='PUT'&&r.url().includes(path+'/drafts/'));
    await save.click(); await updated;
    await page.reload();
    await page.getByText('检查草稿、已确认记录与单次表册',{exact:true}).click();
    await content.waitFor();
    assert.equal(await content.inputValue(),handwritten);
    const final=await saved();
    assert.equal(final.provenance.content,'用户输入');
    assert.equal(final.inspection_id,null);
    assert.equal(await count(),0);
    assert.deepEqual(calls,Array.from({length:3},()=>({model:modelName,allowed:['content'],month})));
    console.log('Chromium 回环模拟模型：建议预览、显式采用和保存、来源、迟到建议冲突、503 后人工输入保存重开均核对，实际检查数为零。');
  });
} finally {
  release?.();
  await new Promise<void>(ok=>mock.close(()=>ok()));
}
