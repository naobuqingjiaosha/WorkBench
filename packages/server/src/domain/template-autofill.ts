import { resolveTemplateVars } from './archive.ts';
import { getWorkbenchLive,templateSupportsWorkType, type Template } from './service.ts';
import { ApiError } from '../api/reply.ts';

/** 自动带入始终返回来源；业务发生日期、人员角色不从系统时间或别的角色猜测。 */
export function templateAutofill(t: Template, names: string[], workbenchId: number | null) {
  const work = workbenchId ? getWorkbenchLive(workbenchId) : null;
  if (workbenchId && !work) throw new ApiError('NOT_FOUND','所选工作不存在或已在回收站',404);
  if (work && !templateSupportsWorkType(t,work.work_type_id)) throw new ApiError('WORK_TYPE_MISMATCH','请选择与模板工作类型一致的工作');
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const pick = (type: string) => parts.find(p=>p.type===type)!.value;
  const year=pick('year'),month=String(Number(pick('month'))),day=String(Number(pick('day')));
  const chinese = `${year}年${month}月${day}日`;
  const iso = `${year}-${pick('month')}-${pick('day')}`;
  const result = resolveTemplateVars(names,workbenchId,work?.work_type_id ?? t.work_type_id,t.position_code,{
    _今天:iso,_今天中文:chinese,_年份:year,_本月:`${year}年${month}月`,
  });
  const safeDates = new Set(['日期','填表日期','填报日期','编制日期','报告日期','汇报日期','今天','当前日期']);
  result.resolved = result.resolved.map(r=> {
    const businessDate = /(?:检查|监督|签订|签署|会议|开工|完工|竣工|验收|申请|报送).*(?:时间|日期|月份|年份)/.test(r.name);
    if (businessDate && (r.from==='system' || /工作台字段 · _/.test(r.via ?? ''))) return {...r,value:'',from:'unmapped' as const,via:'业务发生时间需从档案取得或人工确认，不能默认使用今天'};
    if (/(?:检查人|检查人员|审核人|编制人|填报人|监督人员姓名)/.test(r.name) && r.from==='native' && /负责人|经办人/.test(r.via ?? '')) return {...r,value:'',from:'unmapped' as const,via:'人员角色尚未确认，不能默认沿用负责人或经办人'};
    if (!r.value && safeDates.has(r.name)) return {...r,value:chinese,from:'system' as const,via:'系统日期（Asia/Shanghai，可修改）'};
    return {...r,via:r.via || '未找到可靠来源，请填写或完善工作档案'};
  });
  result.autoCount = result.resolved.filter(r=>r.value!=='').length;
  result.todoCount = result.resolved.length-result.autoCount;
  return {...result,today:chinese,todayISO:iso};
}
