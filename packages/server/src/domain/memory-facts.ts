import { all } from '../db/index.ts';
import { ApiError } from '../api/reply.ts';

export interface FactChoice { value: string; reason: string }
export interface FactConflict {
    field: string;
    value: string;
    candidates: {id:number;value:string;source:string|null}[];
}
export interface FactReview { conflicts: FactConflict[]; choices: Record<string, FactChoice> }

/** 只比较已明确标注字段的事实；不把自由文本猜成结构化事实。 */
export function reviewMemoryFacts(workbenchId: number | null | undefined, periodId: number | null | undefined, values: Record<string,unknown>, choices: Record<string,FactChoice> = {}): FactReview {
    if (!workbenchId) return {conflicts:[],choices};
    const rows=all<{id:number;fact_key:string;fact_value:string;source:string|null}>(`SELECT id,fact_key,fact_value,source FROM agent_memory
      WHERE status='active' AND confirmed=1 AND fact_key IS NOT NULL
      AND (workbench_id IS NULL OR workbench_id=?) AND (period_id IS NULL OR period_id=?)
      AND (valid_from IS NULL OR valid_from<=date('now','+8 hours')) AND (valid_until IS NULL OR valid_until>=date('now','+8 hours'))
      AND NOT EXISTS (SELECT 1 FROM agent_memory newer WHERE newer.supersedes_id=agent_memory.id) ORDER BY id`,[workbenchId,periodId ?? null]);
    const conflicts: FactConflict[]=[];
    for (const field of new Set(rows.map(r=>r.fact_key))) {
        if (!Object.hasOwn(values,field)) continue;
        const value=String(values[field] ?? '').trim(), candidates=rows.filter(r=>r.fact_key===field).map(r=>({id:r.id,value:r.fact_value,source:r.source}));
        if (candidates.some(c=>c.value.trim()!==value)) conflicts.push({field,value,candidates});
    }
    return {conflicts,choices};
}

export function assertFactReview(review: FactReview): void {
    for (const conflict of review.conflicts) {
        const choice=review.choices?.[conflict.field];
        if (!Object.hasOwn(review.choices ?? {},conflict.field) || !choice || choice.value!==conflict.value || typeof choice.reason!=='string' || (!choice.reason.trim() || choice.reason.length>5000))
            throw new ApiError('FACT_CONFLICT', `事实“${conflict.field}”存在来源冲突，请选择本次值并填写确认依据后重新生成`,409,review.conflicts);
    }
}
