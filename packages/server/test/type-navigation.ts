import assert from 'node:assert/strict';
import {workTypeNavigation} from '../src/domain/work-type-navigation.ts';
const {bootstrap}=await import('../src/core/bootstrap.ts');bootstrap();
const {all,run,closeDatabase}=await import('../src/db/index.ts');
const s=await import('../src/domain/service.ts');
const app=(await import('fastify')).default();
(await import('../src/api/routes-core.ts')).registerCoreRoutes(app);
(await import('../src/api/routes-work.ts')).registerWorkRoutes(app);
let checks=0;
const check=(name:string,fn:()=>void)=>{fn();checks++;console.log('✓ '+name);};
try {
 const software=s.listWorkTypes().find(t=>t.code==='software-project')!;
 const eng=s.upsertWorkType({code:'eng',name:'工程类项目',domain:'project',category:'工程类',mode:'process'});
 const pos=s.upsertPosition({work_type_id:eng,code:'E1',name:'工程验收',seq:1});
 const svc=s.upsertWorkType({code:'svc',name:'服务类项目',domain:'project',category:'服务类',description:'无设备环节的纯服务项目，并入信息化类管理。',mode:'process'});
 check('同一归类依据保留独立类型、别名及服务用途',()=>{
   assert.equal(software.navigation_group,'information');assert.equal(s.listWorkTypes().find(t=>t.id===eng)!.display_name,'通用工程流程');
   assert.equal(s.getWorkType(eng)!.name,'工程类项目');assert.equal(s.listWorkTypes().find(t=>t.id===svc)!.navigation_group,'information');
   assert.equal(workTypeNavigation({code:'custom-service',name:'工程技术服务',domain:'project',category:'工程技术服务',description:null}).navigation_group,'engineering');
   assert.equal(workTypeNavigation({code:'unknown-service',name:'服务项目',domain:'project',category:'服务类',description:null}).navigation_group,null);
 });
 const old=s.createWorkbench({name:'匿名历史信息化',workTypeId:software.id});
 const history=()=>JSON.stringify({work:all('SELECT * FROM workbench WHERE id=?',[old.id]),positions:all('SELECT * FROM position_instance WHERE workbench_id=?',[old.id])});
 const before=history();
 const oldStages=JSON.stringify(s.listPositions(software.id));
 check('分类编辑不改历史工作、阶段快照与稳定编码',()=>{
   s.upsertWorkType({...s.getWorkType(software.id)!,navigation_group:'information'});
   assert.equal(history(),before);
   assert.equal(JSON.stringify(s.listPositions(software.id)),oldStages);
 });
 const request=async(payload:object,status:number)=>{const r=await app.inject({method:'POST',url:'/api/workbenches',payload});assert.equal(r.statusCode,status,r.body);checks++;return r.json().data;};
 const information=await request({name:'匿名信息化测试',workTypeId:software.id,domain:'project',navigationGroup:'information'},201);
 const engineering=await request({name:'匿名工程测试',workTypeId:eng,domain:'project',navigationGroup:'engineering'},201);
 check('两类项目继承所选类型原有阶段且保留 P 编号',()=>{
   assert.equal(s.getWorkbenchDetail(information.id)!.positions.length,software.position_count);
   assert.equal(s.getWorkbenchDetail(engineering.id)!.positions[0]!.position_template_id,pos);
   assert.match(information.code,/-P-/);assert.match(engineering.code,/-P-/);
 });
 const count=all('SELECT id FROM workbench').length;
 await request({name:'错误分类',workTypeId:software.id,domain:'project',navigationGroup:'engineering'},400);
 await request({name:'错误入口',workTypeId:software.id,domain:'admin',navigationGroup:'administration'},400);
 const tid=run("INSERT INTO template(code,name,work_type_id,file_rel,file_format) VALUES ('engineering-only','匿名工程模板',?,'sample.docx','docx')",[eng]).lastInsertRowid;
 await request({name:'旧模板残留',workTypeId:software.id,domain:'project',navigationGroup:'information',templateIds:[tid]},400);
 check('错误分类、入口、旧模板均拒绝且不产生工作记录',()=>assert.equal(all('SELECT id FROM workbench').length,count));
 const admin=s.listWorkTypes().find(t=>t.code==='temporary-task')!;
 const adminWork=await request({name:'匿名临时行政',workTypeId:admin.id,domain:'admin',navigationGroup:'administration',recurrence:'once'},201);
 check('行政临时工作不强制周期，保留 A 编号',()=>{assert.match(adminWork.code,/-A-/);assert.equal(s.getWorkbenchDetail(adminWork.id)!.positions.length,0);});
 run("UPDATE work_type SET archived_at='2026-10-19' WHERE id=?",[svc]);
 check('停用类型保留配置入口但不再用于新建',()=>{assert.ok(s.listWorkTypes(true).some(t=>t.id===svc&&t.archived_at));assert.ok(!s.listWorkTypes().some(t=>t.id===svc));assert.throws(()=>s.createWorkbench({name:'停用类型',workTypeId:svc}));});
 const created=await app.inject({method:'POST',url:'/api/work-types',payload:{code:'custom-install',name:'匿名工程安装',domain:'project',category:'安装',navigationGroup:'engineering',mode:'process'}});
 assert.equal(created.statusCode,201,created.body);
 check('分类内新增标记生效且领域不变',()=>{const t=s.listWorkTypes().find(t=>t.id===created.json().data.id)!;assert.equal(t.navigation_group,'engineering');assert.equal(t.domain,'project');});
 console.log(`PASS ${checks} checks; no models called`);
} finally {await app.close();closeDatabase();}
