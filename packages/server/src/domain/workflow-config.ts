import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {all,get,run,tx} from '../db/index.ts';
import {ApiError} from '../api/reply.ts';
import {getWorkType,listPositions,upsertWorkType,upsertPosition,getTemplate,templateAbsPath,listPositionDocBindings,type WorkType} from './service.ts';
import {workTypeNavigation} from './work-type-navigation.ts';
import {periodSpecProblem} from '../core/period-dir.ts';
import {templateFingerprint} from './periods.ts';
import type {WorkflowConfig,ConfigState,ConfigStage,ConfigPeriodMaterial} from './workflow-config-types.ts';
export type {WorkflowConfig} from './workflow-config-types.ts';
type ManagedType=WorkType & {published_config_id:number|null;config_baseline_pending:number};
type Version={id:number;payload:string;digest:string;version_no:number};
type Draft={revision:number;base_version_id:number|null;payload:string};
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const bad=(message:string):never=>{throw new ApiError('BAD_CONFIG',message,400);};
function managed(id:number){const t=getWorkType(id) as ManagedType|undefined;if(!t)throw new ApiError('NOT_FOUND','工作类型不存在',404);return t!;}
function projectionWrite<T>(fn:()=>T):T{return tx(()=>{run('UPDATE workflow_config_write SET allowed=1 WHERE id=1');const result=fn();run('UPDATE workflow_config_write SET allowed=0 WHERE id=1');return result;});}
function capture(id:number):WorkflowConfig{
 const t=managed(id),p:WorkflowConfig={schemaVersion:1,legacyTypeId:id,type:{code:t.code,name:t.name,domain:t.domain,category:t.category,navigation_group:workTypeNavigation(t).navigation_group,mode:t.mode as 'process'|'document',executor:t.executor,description:t.description,icon:t.icon,color:t.color,sort_order:t.sort_order},period:null,stages:[]};
 p.stages=listPositions(id).map(s=>({...s,period_dir:s.period_dir??null,materials:s.materials.map(m=>({...m,key:'material:'+m.id,kind:'legacy' as const})),evidences:s.evidences.map(e=>({...e,key:'evidence:'+e.id})),documents:listPositionDocBindings(s.id).map(d=>({templateId:d.templateId,required:d.required,seq:d.seq,note:null}))}));
 if(t.period_defaults){try{const r=JSON.parse(t.period_defaults);if(!r||!Array.isArray(r.requirements??[])||!Array.isArray(r.steps??[])||(r.requirements??[]).some((v:unknown)=>typeof v!=='string')||(r.steps??[]).some((v:unknown)=>typeof v!=='string'))throw Error();p.period={frequency:r.frequency,due_month_offset:r.due_month_offset??0,due_day:r.due_day??31,remind_days:r.remind_days??3,steps:r.steps??[],materials:(r.requirements??[]).map((title:string,i:number)=>({key:'legacy-period:'+i,title,kind:'legacy',required:true,templateId:null}))};}catch{p.legacyPeriodDefaults=t.period_defaults;}}
 return p;
}
/** Only pending legacy/seed definitions are captured. New drafts explicitly set pending=0. */
export function initializeWorkflowBaselines(){projectionWrite(()=>{
 for(const t of all<ManagedType>('SELECT * FROM work_type WHERE config_baseline_pending=1 AND published_config_id IS NULL')){
  const payload=JSON.stringify(capture(t.id));
  const r=run("INSERT INTO workflow_config_version(work_type_id,version_no,payload,digest,change_note,origin) VALUES(?,1,?,?,?,'legacy-baseline')",[t.id,payload,digest(payload),'迁移/预置兼容基线；不是旧实例的历史版本证明']);
  run('UPDATE work_type SET published_config_id=?,config_baseline_pending=0 WHERE id=?',[r.lastInsertRowid,t.id]);
 }
});}
export function configState(id:number):ConfigState{
 const t=managed(id),v=t.published_config_id?get<Version>('SELECT * FROM workflow_config_version WHERE id=?',[t.published_config_id]):undefined;
 const d=get<Draft>('SELECT * FROM workflow_config_draft WHERE work_type_id=?',[id]);
 if(!d&&!v)throw new ApiError('CONFIG_UNAVAILABLE','配置基线尚未初始化',409);
 const payload=JSON.parse((d??v)!.payload) as WorkflowConfig;
 let issues:string[]=[];try{validateConfig(id,payload);}catch(e){issues=[(e as Error).message];}
 return {typeId:id,publishedId:t.published_config_id,archivedAt:t.archived_at,revision:d?.revision??0,baseVersionId:d?.base_version_id??t.published_config_id,payload,hasDraft:!v||d?.payload!==undefined&&d.payload!==v.payload,versions:all('SELECT id,version_no,change_note,created_at,origin FROM workflow_config_version WHERE work_type_id=? ORDER BY version_no DESC',[id]),issues};
}
function text(v:unknown,label:string,empty=false):asserts v is string {if(typeof v!=='string'||v.length>3000||!empty&&!v.trim())bad(label+'不能为空且长度须合理');}
function integer(v:unknown,label:string,min=0,max=10000):asserts v is number{if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)bad(label+'必须为有效整数');}
function nullable(v:unknown,label:string){if(v!==null)text(v,label,true);}
function list(v:unknown,label:string,max=100):asserts v is unknown[]{if(!Array.isArray(v)||v.length>max)bad(label+'数量或格式无效');}
function flag(v:unknown){if(v!==0&&v!==1)bad('必备标记只能为0或1');}
function validTemplate(id:number){integer(id,'模板编号',1);const t=getTemplate(id);if(!t||t.archived_at||t.health_ok===0||!existsSync(templateAbsPath(t)))bad('模板 #'+id+' 已失效或文件缺失，请明确重新选择');return t!;}
export function validateConfig(id:number,p:WorkflowConfig){
 if(!p||p.schemaVersion!==1||!p.type||JSON.stringify(p).length>500000)bad('配置格式或大小无效');
 const cur=managed(id),t=p.type;text(t.code,'类型编码');if(t.code!==cur.code)bad('类型编码不可修改');text(t.name,'类型名称');text(t.category,'业务分类');
 if(!['admin','project'].includes(t.domain)||!['process','document'].includes(t.mode)||!['general','timesheet'].includes(t.executor))bad('领域、执行方式或能力无效');
 if(!(t.domain==='admin'?t.navigation_group==='administration':['information','engineering'].includes(t.navigation_group??'')))bad('请选择与领域一致的导航分类');
 if(get('SELECT id FROM workbench WHERE work_type_id=? LIMIT 1',[id])&&(['domain','mode','executor','category'] as const).some(k=>t[k]!==cur[k]))bad('已使用类型不能改变领域、业务分类或执行能力，请新建或复制类型');
 for(const k of ['description','icon','color'] as const)nullable(t[k],k);integer(t.sort_order,'类型顺序');
 if(p.legacyPeriodDefaults!==undefined)bad('旧周期配置无法解析，原文已保留；请明确配置周期或清除该旧值');
 if(p.legacyTypeId!==undefined&&p.legacyTypeId!==id)bad('不能继承其他类型的旧业务识别规则');
 list(p.stages,'阶段');if(t.mode==='process'&&!p.stages.length)bad('阶段流程至少配置一个阶段');if(t.mode==='document'&&p.stages.length)bad('文书类型不能同时发布阶段流程');if(t.mode==='process'&&p.period)bad('阶段流程不能配置独立周期');
 const codes=new Set<string>(),keys=new Set<string>();const unique=(key:string)=>{text(key,'条目标识');if(keys.has(key))bad('条目标识重复');keys.add(key);};
 for(const s of p.stages){if(s.id!==undefined&&!get('SELECT id FROM position_template WHERE id=? AND work_type_id=? AND code=?',[s.id,id,s.code]))bad('阶段身份或编码已变化，请保留原编码或新增阶段');text(s.code,'阶段编码');if(codes.has(s.code))bad('阶段编码重复');codes.add(s.code);text(s.name,'阶段名称');integer(s.seq,'阶段顺序',1);for(const k of ['folder_name','period_dir','description','duration_hint'] as const)nullable(s[k],k);
  if(s.folder_name&&(/[\\/:*?"<>|\r\n\t]/.test(s.folder_name)||s.folder_name.includes('..')||s.folder_name.trim()!==s.folder_name||/^[.]|[.]$/.test(s.folder_name)))bad('阶段目录名无效');if(s.period_dir&&periodSpecProblem(s.period_dir))bad('阶段期次目录格式无效');
  list(s.materials,'材料');list(s.evidences,'影像');list(s.documents,'阶段模板');const docs=new Set<number>();
  for(const m of s.materials){unique(m.key);text(m.name,'材料名称');text(m.category,'材料分类');flag(m.required);nullable(m.hint,'材料提示');nullable(m.retention,'留存说明');if(!['external','reference','generated','legacy'].includes(m.kind))bad('材料用途无效');if(m.kind==='legacy'&&p.legacyTypeId!==id)bad('请为复制的材料明确选择用途');if(m.template_id!==null)validTemplate(m.template_id);}
  for(const e of s.evidences){unique(e.key);text(e.title,'影像名称');flag(e.required);integer(e.min_count,'影像最少数量');if(e.max_count!==null){integer(e.max_count,'影像最多数量');if(e.max_count<e.min_count)bad('影像数量范围无效');}for(const k of ['shooting_points','angles','hint'] as const)nullable(e[k],k);}
  for(const d of s.documents){validTemplate(d.templateId);if(docs.has(d.templateId))bad('阶段模板重复');docs.add(d.templateId);flag(d.required);integer(d.seq,'模板顺序');nullable(d.note,'模板说明');}
 }
 if(new Set(p.stages.map(s=>s.seq)).size!==p.stages.length)bad('阶段顺序不可重复');
 if(p.period){const r=p.period;if(!['monthly','quarterly','yearly'].includes(r.frequency))bad('周期频率无效');integer(r.due_day,'截止日',1,31);integer(r.due_month_offset,'截止月份偏移',0,r.frequency==='monthly'?1:r.frequency==='quarterly'?3:12);integer(r.remind_days,'提醒天数',0,365);list(r.steps,'步骤',50);r.steps.forEach(s=>text(s,'步骤'));list(r.materials,'周期材料');
  let old:WorkflowConfig|undefined;if(p.legacyTypeId===id&&cur.published_config_id)old=JSON.parse(get<Version>('SELECT * FROM workflow_config_version WHERE id=?',[cur.published_config_id])!.payload);
  for(const m of r.materials){unique(m.key);text(m.title,'周期材料名称');if(typeof m.required!=='boolean'||!['external','reference','generated','legacy'].includes(m.kind))bad('周期材料用途或必备性无效');if(m.kind==='legacy'&&!old?.period?.materials.some(o=>o.key===m.key&&o.title===m.title&&o.kind==='legacy'))bad('新建或改名材料必须明确选择用途');if(m.templateId!==null){if(m.kind!=='generated')bad('只有生成成果可以指定成果模板');validTemplate(m.templateId);}}
 }
 if(t.executor==='timesheet'&&(t.mode!=='document'||p.period?.frequency!=='monthly'))bad('工时能力只能用于月度文书类型');
}
function expected(id:number,revision:unknown,base:unknown){const t=managed(id),d=get<Draft>('SELECT * FROM workflow_config_draft WHERE work_type_id=?',[id]);if(revision!==(d?.revision??0)||base!==t.published_config_id||(d&&d.base_version_id!==base))throw new ApiError('STALE_CONFIG','配置已被其他窗口保存或发布；本页输入保留，请核对最新版本',409);return {t,d};}
/** Incomplete drafts are allowed; malformed shapes must not crash the editor on reload. */
function validateDraftShape(p:WorkflowConfig){
 const strings=(o:object,keys:string[])=>{for(const k of keys)if(typeof (o as Record<string,unknown>)[k]!=='string')bad('草稿文本字段格式无效：'+k);};
 if(!p||!p.type||p.schemaVersion!==1||JSON.stringify(p).length>500000)bad('草稿格式或大小无效');
 strings(p.type,['code','name','domain','category','mode','executor']);list(p.stages,'阶段');
 for(const s of p.stages){if(!s)bad('阶段格式无效');strings(s,['code','name']);list(s.materials,'材料');list(s.evidences,'影像');list(s.documents,'模板');for(const m of s.materials){if(!m)bad('材料格式无效');strings(m,['key','name','category','kind']);}for(const e of s.evidences){if(!e)bad('影像格式无效');strings(e,['key','title']);}for(const d of s.documents)if(!d||typeof d.templateId!=='number')bad('模板引用格式无效');}
 if(p.period!==null){if(!p.period)bad('周期格式无效');strings(p.period,['frequency']);list(p.period.steps,'步骤');list(p.period.materials,'周期材料');for(const step of p.period.steps)if(typeof step!=='string')bad('步骤应为文本');for(const m of p.period.materials){if(!m)bad('周期材料格式无效');strings(m,['key','title','kind']);}}
}
export function saveConfigDraft(id:number,b:Record<string,unknown>){return tx(()=>{
 expected(id,b.revision,b.baseVersionId);const p=b.payload as WorkflowConfig;
 validateDraftShape(p);
 // Drafts may be incomplete but must be bounded JSON with the original identity.
 if(!p||p.schemaVersion!==1||!p.type||p.type.code!==managed(id).code||JSON.stringify(p).length>500000)bad('草稿格式、大小或类型编码无效');
 run("INSERT INTO workflow_config_draft(work_type_id,base_version_id,payload) VALUES(?,?,?) ON CONFLICT(work_type_id) DO UPDATE SET payload=excluded.payload,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",[id,managed(id).published_config_id,JSON.stringify(p)]);return configState(id);
});}
export function discardConfigDraft(id:number,b:Record<string,unknown>){const t=managed(id);if(!t.published_config_id)bad('未发布类型请继续完善草稿；不自动删除类型');return saveConfigDraft(id,{...b,payload:JSON.parse(get<Version>('SELECT * FROM workflow_config_version WHERE id=?',[t.published_config_id])!.payload)});}
export function createConfigType(b:Record<string,unknown>){return tx(()=>{
 text(b.code,'新类型编码');text(b.name,'新类型名称');if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(b.code))bad('编码只能使用字母、数字、横线和下划线');if(get('SELECT id FROM work_type WHERE code=?',[b.code]))throw new ApiError('CODE_EXISTS','类型编码已存在',409);
 const group=b.navigationGroup??'administration';if(!['information','engineering','administration'].includes(String(group)))bad('导航分类无效');
 let p:WorkflowConfig={schemaVersion:1,type:{code:b.code,name:b.name,domain:group==='administration'?'admin':'project',category:group==='administration'?'部门综合管理':group==='engineering'?'工程项目':'信息化项目',navigation_group:group as WorkflowConfig['type']['navigation_group'],mode:group==='administration'?'document':'process',executor:'general',description:null,icon:null,color:null,sort_order:100},stages:[],period:null};
 if(b.copyFrom!==undefined){integer(b.copyFrom,'来源类型',1);const source=managed(b.copyFrom);if(!source.published_config_id||b.sourceVersionId!==source.published_config_id)throw new ApiError('STALE_CONFIG','复制来源的已发布版本已变化，请重新选择',409);p=JSON.parse(get<Version>('SELECT * FROM workflow_config_version WHERE id=?',[source.published_config_id])!.payload);delete p.legacyTypeId;p.type.code=b.code;p.type.name=b.name;for(const s of p.stages){delete s.id;for(const m of s.materials){delete m.id;m.key=randomUUID();}for(const e of s.evidences){delete e.id;e.key=randomUUID();}}for(const m of p.period?.materials??[])m.key=randomUUID();}
 const t=p.type;const r=run('INSERT INTO work_type(code,name,domain,category,navigation_group,mode,executor,config_baseline_pending) VALUES(?,?,?,?,?,?,?,0)',[t.code,t.name,t.domain,t.category,t.navigation_group,t.mode,t.executor]);
 run('INSERT INTO workflow_config_draft(work_type_id,payload) VALUES(?,?)',[r.lastInsertRowid,JSON.stringify(p)]);return configState(r.lastInsertRowid);
});}
function project(id:number,p:WorkflowConfig){
 const t=p.type;upsertWorkType({...t,id,period_defaults:p.period?JSON.stringify(periodDefaults(p)):null});
 run('UPDATE work_type SET description=?,icon=?,color=? WHERE id=?',[t.description,t.icon,t.color,id]);
 run("UPDATE position_template SET archived_at=COALESCE(archived_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE work_type_id=?",[id]);
 for(const s of p.stages){const pid=upsertPosition({...s,work_type_id:id,sort_order:s.seq*10});s.id=pid;run('UPDATE position_template SET archived_at=NULL,folder_name=?,period_dir=?,description=?,duration_hint=? WHERE id=?',[s.folder_name,s.period_dir,s.description,s.duration_hint,pid]);
  for(const table of ['material_check','evidence_rule'])run(`UPDATE ${table} SET archived_at=COALESCE(archived_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE position_template_id=?`,[pid]);
  for(const m of s.materials){const old=get<{id:number}>('SELECT id FROM material_check WHERE position_template_id=? AND (config_key=? OR (?=? AND id=?))',[pid,m.key,m.key,'material:'+m.id,m.id??-1]);const vals=[m.name,m.category,m.kind,m.required,m.template_id,m.retention,m.hint,m.key];if(old)run('UPDATE material_check SET name=?,category=?,requirement_kind=?,required=?,template_id=?,retention=?,hint=?,config_key=?,archived_at=NULL WHERE id=?',[...vals,old.id]);else run('INSERT INTO material_check(name,category,requirement_kind,required,template_id,retention,hint,config_key,position_template_id) VALUES(?,?,?,?,?,?,?,?,?)',[...vals,pid]);}
  for(const e of s.evidences){const old=get<{id:number}>('SELECT id FROM evidence_rule WHERE position_template_id=? AND (config_key=? OR (?=? AND id=?))',[pid,e.key,e.key,'evidence:'+e.id,e.id??-1]);const vals=[e.title,e.required,e.min_count,e.max_count,e.shooting_points,e.angles,e.hint,e.key];if(old)run('UPDATE evidence_rule SET title=?,required=?,min_count=?,max_count=?,shooting_points=?,angles=?,hint=?,config_key=?,archived_at=NULL WHERE id=?',[...vals,old.id]);else run('INSERT INTO evidence_rule(title,required,min_count,max_count,shooting_points,angles,hint,config_key,position_template_id) VALUES(?,?,?,?,?,?,?,?,?)',[...vals,pid]);}
  run('DELETE FROM position_template_doc WHERE position_template_id=?',[pid]);for(const d of s.documents)run('INSERT INTO position_template_doc(position_template_id,template_id,required,seq,note) VALUES(?,?,?,?,?)',[pid,d.templateId,d.required,d.seq,d.note]);
 }
}
export function periodDefaults(p:WorkflowConfig){const r=p.period!;return {...r,requirements:r.materials.map(m=>m.title),material_rules:r.materials};}
function preparePublication(id:number,b:Record<string,unknown>){
 const {t,d}=expected(id,b.revision,b.baseVersionId);if(!d)bad('请先保存草稿');const p=JSON.parse(d!.payload) as WorkflowConfig;validateConfig(id,p);
 for(const s of p.stages){for(const doc of s.documents)doc.digest=templateFingerprint(validTemplate(doc.templateId));for(const m of s.materials)if(m.template_id)m.templateDigest=templateFingerprint(validTemplate(m.template_id));}
 for(const m of p.period?.materials??[])if(m.templateId)m.templateDigest=templateFingerprint(validTemplate(m.templateId));
 const last=t.published_config_id?get<Version>('SELECT * FROM workflow_config_version WHERE id=?',[t.published_config_id]):undefined;
 return {t,p,last};
}
export function previewConfig(id:number,b:Record<string,unknown>){const {p,last}=preparePublication(id,b);return {before:last?JSON.parse(last.payload):null,after:p,digest:digest(JSON.stringify(p))};}
export function publishConfig(id:number,b:Record<string,unknown>){return projectionWrite(()=>{
 text(b.operationId,'发布操作编号');text(b.note,'发布说明');const request=JSON.stringify({id,revision:b.revision,baseVersionId:b.baseVersionId,note:b.note,previewDigest:b.previewDigest});
 const previous=get<{detail:string}>('SELECT detail FROM workflow_event WHERE operation_id=?',[b.operationId]);if(previous){if(JSON.parse(previous.detail).request!==request)throw new ApiError('OPERATION_CONFLICT','操作编号已被不同请求使用',409);return configState(id);}
 const {t,p,last}=preparePublication(id,b);
 if(b.previewDigest!==digest(JSON.stringify(p)))throw new ApiError('STALE_PREVIEW','配置或模板已变化，请重新检查差异',409);
 let payload=JSON.stringify(p);
 if(last?.payload===payload)throw new ApiError('NO_CHANGE','草稿与已发布配置相同，无需重复发布',409);
 project(id,p);payload=JSON.stringify(p);const v=run('INSERT INTO workflow_config_version(work_type_id,version_no,payload,digest,change_note) VALUES(?,?,?,?,?)',[id,(last?.version_no??0)+1,payload,digest(payload),b.note]);
 run('UPDATE work_type SET published_config_id=? WHERE id=?',[v.lastInsertRowid,id]);run('UPDATE workflow_config_draft SET base_version_id=?,payload=?,revision=revision+1 WHERE work_type_id=?',[v.lastInsertRowid,payload,id]);
 run("INSERT INTO workflow_event(action,detail,operation_id) VALUES('config-published',?,?)",[JSON.stringify({request,typeId:id,before:t.published_config_id,after:v.lastInsertRowid}),b.operationId]);return configState(id);
});}
export function setConfigAvailability(id:number,b:Record<string,unknown>){return tx(()=>{const t=managed(id);if(b.expectedArchivedAt!==t.archived_at||b.publishedId!==t.published_config_id)throw new ApiError('STALE_CONFIG','类型状态已变化，请重新核对',409);if(typeof b.enabled!=='boolean')bad('请选择启用或停用');if(b.enabled&&!t.published_config_id)bad('请先发布配置');run("UPDATE work_type SET archived_at=CASE WHEN ?=1 THEN NULL ELSE COALESCE(archived_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) END WHERE id=?",[b.enabled?1:0,id]);return configState(id);});}
export function publishedConfigForCreate(id:number,expectedId:unknown){const t=managed(id);if(!t.published_config_id)throw new ApiError('CONFIG_UNPUBLISHED','此类型尚未发布，请先完成流程配置',409);if(expectedId!==t.published_config_id)throw new ApiError('STALE_CONFIG','所选类型的发布版本已变化或未提供，请重新选择工作类型',409);if(t.archived_at)throw new ApiError('TYPE_DISABLED','此类型已停用，不能新建工作',409);const v=get<Version>('SELECT * FROM workflow_config_version WHERE id=?',[t.published_config_id])!;const p=JSON.parse(v.payload) as WorkflowConfig;if(p.legacyPeriodDefaults)bad('旧周期配置无法解析，请先在流程规范中明确处理');
 for(const s of p.stages){for(const d of s.documents){const t=validTemplate(d.templateId);if(d.digest&&d.digest!==templateFingerprint(t))throw new ApiError('TEMPLATE_CHANGED','流程引用的模板已变化，请重新检查并发布配置',409);}for(const m of s.materials)if(m.template_id){const t=validTemplate(m.template_id);if(m.templateDigest&&m.templateDigest!==templateFingerprint(t))throw new ApiError('TEMPLATE_CHANGED','材料模板已变化，请重新发布配置',409);}}
 for(const m of p.period?.materials??[])if(m.templateId){const t=validTemplate(m.templateId);if(m.templateDigest&&m.templateDigest!==templateFingerprint(t))throw new ApiError('TEMPLATE_CHANGED','周期模板已变化，请重新发布配置',409);}
 return {id:v.id,payload:p};}
export function rejectLegacyConfigWrite():never{throw new ApiError('CONFIG_DRAFT_REQUIRED','请在流程规范中保存草稿并明确发布；旧接口不再直接修改规范',409);}
export function assertTemplateNotVersioned(id:number){for(const v of all<{payload:string}>('SELECT payload FROM workflow_config_version')){const p=JSON.parse(v.payload) as WorkflowConfig;if(p.stages.some(s=>s.documents.some(d=>d.templateId===id)||s.materials.some(m=>m.template_id===id))||p.period?.materials.some(m=>m.templateId===id))throw new ApiError('CONFIG_TEMPLATE_IN_USE','模板被流程版本引用，只能归档，不能彻底删除',409);}}
