/** Serializable configuration only; no business facts, files or executable expressions. */
export interface ConfigMaterial { key:string; id?:number; name:string; category:string; kind:'external'|'reference'|'generated'|'legacy'; required:number; template_id:number|null; retention:string|null; hint:string|null; templateDigest?:string }
export interface ConfigEvidence { key:string; id?:number; title:string; required:number; min_count:number; max_count:number|null; shooting_points:string|null; angles:string|null; hint:string|null }
export interface ConfigDocument { templateId:number; required:number; seq:number; note:string|null; digest?:string }
export interface ConfigStage { id?:number; code:string; name:string; seq:number; folder_name:string|null; period_dir:string|null; description:string|null; duration_hint:string|null; materials:ConfigMaterial[]; evidences:ConfigEvidence[]; documents:ConfigDocument[] }
export interface ConfigPeriodMaterial { key:string; title:string; kind:'external'|'reference'|'generated'|'legacy'; required:boolean; templateId:number|null; templateDigest?:string }
export interface ConfigPeriod { frequency:'monthly'|'quarterly'|'yearly'; due_month_offset:number; due_day:number; remind_days:number; steps:string[]; materials:ConfigPeriodMaterial[] }
export interface WorkflowConfig {
 schemaVersion:1;
 type:{code:string;name:string;domain:'admin'|'project';category:string;navigation_group:'information'|'engineering'|'administration'|null;mode:'process'|'document';executor:'general'|'timesheet';description:string|null;icon:string|null;color:string|null;sort_order:number};
 stages:ConfigStage[];
 period:ConfigPeriod|null;
 /** Unparseable legacy defaults are retained verbatim, never silently repaired. */
 legacyPeriodDefaults?:string;
 legacyTypeId?:number;
}
export interface ConfigState {typeId:number;publishedId:number|null;archivedAt:string|null;revision:number;baseVersionId:number|null;payload:WorkflowConfig;hasDraft:boolean;versions:{id:number;version_no:number;change_note:string;created_at:string;origin:string}[];issues:string[]}
