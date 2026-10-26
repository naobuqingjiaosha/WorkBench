import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {WorkRecord} from '../src/domain/work-records.ts';

(await import('../src/core/bootstrap.ts')).bootstrap();
const d=await import('../src/db/index.ts'),s=await import('../src/domain/service.ts'),r=await import('../src/domain/work-records.ts'),a=await import('../src/domain/agent.ts');
const app=(await import('fastify')).default();(await import('../src/api/routes-agent.ts')).registerAgentRoutes(app);
let passed=0;async function check(name:string,fn:()=>unknown|Promise<unknown>){await fn();passed++;console.log('✓ '+name)}
async function api(method:'GET'|'POST'|'PUT',url:string,payload?:object,status=200){const res=await app.inject({method,url,payload});assert.equal(res.statusCode,status,res.body);return res.json().data;}
const create=(text:string,extra:Record<string,unknown>={})=>r.createWorkRecord({text,request_key:randomUUID(),...extra});
try{
 await check('038迁移只增加记录结构，旧类型／工作／记忆原样保留并可重复执行',()=>{
  const path=join(process.env.WORKBENCH_ISOLATION_ROOT!,'compat.db'),db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');
  const dir=new URL('../src/db/migrations/',import.meta.url);for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')&&f<'038').sort())db.exec(readFileSync(new URL(f,dir),'utf8'));
  db.exec("INSERT INTO work_type(code,name,domain,category,mode) VALUES('temporary-task','旧临时','admin','临时','document')");
  db.exec("INSERT INTO workbench(code,name,work_type_id,folder_path) VALUES('OLD-01','历史单次工作',1,'old-folder')");
  db.exec("INSERT INTO agent_memory(text,source) VALUES('既有备忘','手工')");
  const before=['work_type','workbench','agent_memory'].map(t=>JSON.stringify(db.prepare('SELECT * FROM '+t).all()));
  db.exec(readFileSync(new URL('038_work_records.sql',dir),'utf8'));
  assert.deepEqual(['work_type','workbench','agent_memory'].map(t=>JSON.stringify(db.prepare('SELECT * FROM '+t).all())),before);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);db.close();
 });
 await check('日期和性质保守识别：已做、计划、否定、混合时间、跨年与无日期',()=>{
  assert.equal(r.interpretRecord('昨天我已经发送会议材料','2026-01-01').occurred_from,'2025-12-31');
  assert.equal(r.interpretRecord('今天已经完成报告','2026-10-21').nature,'done');
  assert.equal(r.interpretRecord('明天准备发送报告','2026-10-21').nature,'plan');
  assert.notEqual(r.interpretRecord('今天还没有完成报告','2026-10-21').nature,'done');
  assert.equal(r.interpretRecord('今天已完成报告，明天准备发出','2026-10-21').nature,'unknown');
  assert.equal(r.interpretRecord('今天已完成报告，明天准备发出','2026-10-21').occurred_from,null);
  assert.equal(r.interpretRecord('上周完成了整理','2026-10-21').occurred_from,'2026-10-12');
  assert.equal(r.interpretRecord('已经发出报告').occurred_from,null);
  assert.equal(r.interpretRecord('2026年2月30日已完成').occurred_from,null);
 });
 await check('空白、错误日期、未来已做、错误关联被拒绝，不落空记录',()=>{
  const n=r.searchWorkRecords().total;assert.throws(()=>create('  '));assert.throws(()=>create('材料',{occurred_from:'2026-02-30'}));assert.throws(()=>create('已完成',{nature:'done',occurred_from:'2999-01-01'}));assert.throws(()=>create('记录',{workbench_id:999999}));assert.equal(r.searchWorkRecords().total,n);
 });
 let stored:WorkRecord;
 await check('保存原话、不创建工作或待办，同一请求重试幂等、异内容同键拒绝',()=>{
  const count=d.get<{n:number}>('SELECT count(*) n FROM workbench')!.n,key=randomUUID(),payload={text:'今天已经把独立示例材料发给办公室',request_key:key};stored=r.createWorkRecord(payload);assert.equal(stored.text,payload.text);assert.equal(r.createWorkRecord(payload).id,stored.id);assert.throws(()=>r.createWorkRecord({...payload,text:'其他内容'}),/提交标识/);assert.equal(d.get<{n:number}>('SELECT count(*) n FROM workbench')!.n,count);assert.notEqual(create(payload.text).id,stored.id);
 });
 await check('重开数据库后原话及修订仍存在，迁移重复启动不重写旧数据',()=>{const path=d.getDbPath();d.closeDatabase();d.initDatabase(path);assert.equal(r.requireRecord(stored.id).text,stored.text);});
 await check('超过200条也能按发生时间完整查询及分页，不用录入时间冒充月份',()=>{
  d.tx(()=>{for(let i=0;i<215;i++)create('旧月独立标记 '+i,{occurred_from:'2025-01-10',nature:i%2?'plan':'done'});});
  const first=r.searchWorkRecords({from:'2025-01-01',to:'2025-01-31',q:'旧月独立标记',pageSize:100});assert.equal(first.total,215);assert.equal(first.items.length,100);assert.equal(r.searchWorkRecords({from:'2025-01-01',to:'2025-01-31',q:'旧月独立标记',page:3,pageSize:100}).items.length,15);
  assert.equal(r.searchWorkRecords({from:'2026-10-01',to:'2026-10-31',q:'旧月独立标记'}).total,0);
  create('未知日独立标记');const result=r.searchWorkRecords({q:'未知日独立标记',from:'2025-01-01',to:'2025-01-31'});assert.equal(result.total,0);assert.equal(result.unknownDateCount,1);assert.equal(result.unknownItems.length,1);
 });
 await check('关键词含SQL字符按字面匹配；范围和分页参数拒绝非法值',()=>{assert.equal(r.searchWorkRecords({q:"' OR 1=1 --"}).total,0);assert.throws(()=>r.searchWorkRecords({from:'2026-10-30',to:'2026-10-01'}));assert.throws(()=>r.searchWorkRecords({page:-1}));assert.throws(()=>r.searchWorkRecords({pageSize:101}));});
 await check('更正保留旧版本并拒绝并发覆盖，撤回与恢复可逆',()=>{
  const next=r.changeWorkRecord(stored.id,{revision:1,text:'更正后的独立示例材料',occurred_from:'2026-01-03',occurred_to:'2026-01-03'});assert.equal(next.revision,2);assert.equal(r.recordHistory(next.id)[0]!.text,stored.text);assert.throws(()=>r.changeWorkRecord(stored.id,{revision:1,text:'过时修改'}),/已被更正/);
  const withdrawn=r.changeWorkRecord(next.id,{revision:2,status:'withdrawn'});assert.equal(r.searchWorkRecords({q:'更正后的独立示例材料'}).total,0);assert.equal(r.searchWorkRecords({q:'更正后的独立示例材料',status:'withdrawn'}).total,1);assert.throws(()=>r.changeWorkRecord(next.id,{revision:withdrawn.revision,text:'直接改撤回记录'}),/先恢复/);r.changeWorkRecord(next.id,{revision:3,status:'active'});assert.equal(r.searchWorkRecords({q:'更正后的独立示例材料'}).total,1);
 });
 await check('助手明确告知直接记下，无模型调用、无待确认动作，重试只存一次',async()=>{
  const payload={message:'今天我已经把助手示例资料发给办公室了',requestKey:randomUUID()};const before=d.get<{n:number}>('SELECT count(*) n FROM work_record')!.n;
  const reply=await api('POST','/api/agent/chat',payload,201),retry=await api('POST','/api/agent/chat',payload,201);assert.match(reply.text,/已记下/);assert.equal(reply.model,'本地工作记录');assert.equal(reply.usage.total,0);assert.equal(reply.actions.length,0);assert.equal(reply.messageId,retry.messageId);assert.equal(d.get<{n:number}>('SELECT count(*) n FROM work_record')!.n,before+1);
 });
 await check('助手新对话可完整查询旧月份，计划与已做分别标明且有记录引用',async()=>{
  const reply=await a.runAgentTurn({message:'我2025年1月做了什么？',requestKey:randomUUID()});assert.match(reply.text,/215条/);assert.match(reply.text,/计划/);assert.match(reply.text,/#\/records\?id=/);assert.match(reply.text,/第1\/5页/);assert.equal(reply.model,'本地工作记录');
 });
 await check('助手查询及总结引用更正后可追溯变化，旧回复内容保留',async()=>{
  const item=create('来源变化独立标记 已经完成',{occurred_from:'2025-01-01'});const reply=await a.runAgentTurn({message:'查询工作记录 关键词：来源变化独立标记',requestKey:randomUUID()});assert.match(reply.text,/来源变化独立标记/);r.changeWorkRecord(item.id,{revision:1,status:'withdrawn'});assert.ok(a.listMessages(reply.sessionId).some(m=>/引用的工作记录已更正或撤回/.test(m.content)));const latest=await a.runAgentTurn({message:'查询工作记录 关键词：来源变化独立标记'});assert.match(latest.text,/找到0条/);
 });
 await check('输入模式明确时可记录自由原话，普通问题及引用不误记为工作',async()=>{
  assert.equal(r.recordIntent('今天如何发送材料？'),null);assert.equal(r.recordIntent('他说今天已经发给办公室了'),null);assert.equal(r.recordIntent('如果今天我已经完成了会怎样'),null);
  const reply=await a.runAgentTurn({message:'与办公室沟通材料事宜',recordMode:'capture',requestKey:randomUUID()});assert.match(reply.text,/已记下/);assert.match(reply.text,/性质待明确/);
 });
 await check('新建通用单次受阻，项目、谈话、周期仍可建立，旧工作可读取',async()=>{
  const type=(code:string)=>s.listWorkTypes().find(t=>t.code===code)!;
  for(const code of ['temporary-task','integrity-temporary','admin'])assert.throws(()=>s.createWorkbench({name:'应改为记录',workTypeId:type(code).id}),/工作记录/);
  const project=s.createWorkbench({name:'保留项目',workTypeId:type('software-project').id}),talk=s.createWorkbench({name:'保留专项',workTypeId:type('integrity-talk').id});assert.ok(s.getWorkbenchDetail(project.id));assert.ok(s.getWorkbenchDetail(talk.id));
  assert.ok(s.createWorkbench({name:'保留通用周期',workTypeId:type('admin').id,periodRule:{frequency:'monthly',due_day:31,requirements:[]}}));
  const {periodDue}=await import('../src/domain/periods.ts');
  assert.equal(periodDue('2026-04-01',0,31),'2026-04-30');assert.equal(periodDue('2026-02-01',0,31),'2026-02-28');assert.equal(periodDue('2028-02-01',0,31),'2028-02-29');assert.equal(periodDue('2026-03-01',0,31),'2026-03-31');
  const id=d.run("INSERT INTO workbench(code,name,work_type_id,folder_path) VALUES('LEGACY-01','旧单次工作',?,'legacy')",[type('temporary-task').id]).lastInsertRowid;assert.equal(s.getWorkbench(id)!.name,'旧单次工作');assert.ok(s.listWorkbenches().some(w=>w.id===id));
  const file=join(process.env.WORKBENCH_DATA_DIR!,'legacy-proof.txt');writeFileSync(file,'旧文件内容');create('与旧工作关联的记录',{workbench_id:id});assert.equal(readFileSync(file,'utf8'),'旧文件内容');
 });
 await check('REST接口保存、查看历史、更正及错误响应与领域规则一致',async()=>{
  const created=await api('POST','/api/work-records',{text:'API原话',request_key:randomUUID()},201);await api('PUT',`/api/work-records/${created.id}`,{revision:1,text:'API更正'});const detail=await api('GET',`/api/work-records/${created.id}`);assert.equal(detail.history.length,1);assert.equal(detail.record.text,'API更正');await api('PUT',`/api/work-records/${created.id}`,{revision:1,text:'过时'},409);await api('POST','/api/work-records',{text:'   ',request_key:randomUUID()},400);
 });
 await check('今天查询仅取当天；明确引用与假设不自动保存',()=>{
  assert.deepEqual(r.queryFromRecordMessage('我今天做了什么？','2026-10-21'),{pageSize:50,from:'2026-10-21',to:'2026-10-21'});
  assert.equal(r.interpretRecord('去年10月3日已经完成','2026-10-21').occurred_from,'2025-10-03');
 });
 await check('模型检索记录保留来源修订，正文截断明示，更正后旧对话不回灌过期事实',async()=>{
  const providers=await import('../src/ai/providers.ts');
  const providerId=providers.upsertProvider({code:'fake-records',name:'隔离模拟模型',base_url:'http://127.0.0.1:19445/v1',enabled:1});
  providers.upsertProfile({purpose:'agent',name:'隔离模拟',provider_id:providerId,model:'fake-records',max_tokens:2048,timeout_ms:100});
  const captured=await a.runAgentTurn({message:'记一下：模型独有事实尾部'+ '原'.repeat(700),requestKey:randomUUID()});
  const item=r.searchWorkRecords({q:'模型独有事实尾部'}).items[0]!;
  const originalFetch=globalThis.fetch;let calls=0,checkHistory=false;
  globalThis.fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body));calls++;
   if(checkHistory){assert.ok(!body.messages.some((m:{content:string})=>m.content?.includes('模型独有事实尾部')));}
   if(calls===2){const payload=JSON.parse(body.messages.find((m:{role:string})=>m.role==='tool').content);assert.equal(payload.items[0].truncated,true);assert.equal(payload.items[0].text.length,600);assert.ok(payload.contentNote);}
   return new Response(JSON.stringify({model:'fake-records',choices:[{message:calls===1?{role:'assistant',content:'',tool_calls:[{id:'record-read',type:'function',function:{name:'search_work_records',arguments:JSON.stringify({q:'模型独有事实尾部'})}}]}:{role:'assistant',content:'基于来源的测试回答'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}),{status:200});
  };
  try{const reply=await a.runAgentTurn({message:'请参考此前材料提供整理建议',sessionId:captured.sessionId});assert.equal(calls,2);assert.ok(d.get('SELECT id FROM work_record_answer WHERE message_id=?',[reply.messageId]));r.changeWorkRecord(item.id,{revision:item.revision,status:'withdrawn'});assert.ok(a.listMessages(reply.sessionId).find(m=>m.id===reply.messageId)!.content.includes('已更正或撤回'));checkHistory=true;await a.runAgentTurn({message:'再说说一般整理原则',sessionId:reply.sessionId});assert.equal(calls,3);}finally{globalThis.fetch=originalFetch;}
 });
 assert.equal(d.all('PRAGMA foreign_key_check').length,0);console.log(`工作记录专项：${passed}项通过`);
}finally{await app.close();d.closeDatabase();}
