export type ReportRow={key:string;sheet:string;row:number;name:string;unit:string;completed:string;progress:string;duplicate:boolean};
export type ReportPreview={month:string;titleMonth:number|null;titleYear:number|null;warning:string;rows:ReportRow[]};
export type ReportChoice={key:string;name:string;target:string;alias:boolean};
export type AdoptedProjectReport={id:string;digest:string;month:string;sourceName?:string;monthConfirmed:boolean;mergeConfirmed:boolean;choices:ReportChoice[]};
export type PendingProjectReport={id:string;name:string;month:string;digest:string;preview?:ReportPreview;formalNames?:string[];catalog?:TemplateProjectCatalog;error?:string;verified?:boolean;monthConfirmed:boolean;mergeConfirmed:boolean;choices:(ReportChoice&{selected:boolean;confirmed:boolean})[]};
export type TemplateProjectCatalog={items:{name:string;sheet:string;row:number;customer:string;contract:string}[];warnings:string[]};
type ProjectInput={month:string;projects:string[];projectAliases?:Record<string,string>;pendingProjectReport?:PendingProjectReport;projectReport?:AdoptedProjectReport;projectReportHistory?:AdoptedProjectReport[]};

export function adoptProjectReport<T extends ProjectInput>(input:T):T{
 const p=input.pendingProjectReport;
 if(!p?.verified||!p.preview||p.month!==input.month||p.preview.month!==input.month||!p.monthConfirmed)throw Error('请重新读取月报并确认办理年月');

 const choices=p.choices.filter(c=>c.selected).map(c=>({...c,target:c.target.trim()}));
 if(!choices.length)throw Error('请至少选择一个项目');
 const aliases={...input.projectAliases},targets=new Set<string>(),keys=new Set<string>();
 for(const c of choices){
  const row=p.preview.rows.find(r=>r.key===c.key&&r.name===c.name);
  if(!row||keys.has(c.key)||!c.confirmed||!c.target||c.target.length>300)throw Error('请逐项选择或填写正式名称，并确认映射');
  keys.add(c.key);
  if(targets.has(c.target)&&!p.mergeConfirmed)throw Error('多行映射到同一正式项目，请核对并确认合并');
  targets.add(c.target);
  if(c.alias){
   if(c.name.length<2||choices.some(other=>other.name===c.name&&other.target!==c.target))throw Error('同名月报项目映射有歧义，不能自动建立简称');
   if(aliases[c.name]&&aliases[c.name]!==c.target)throw Error('已有同名简称对应其他项目，请先人工核对，原简称未覆盖');
   aliases[c.name]=c.target;
  }
 }
 const history=[...(input.projectReportHistory??[])];
 if(input.projectReport&&input.projectReport.digest!==p.digest&&!history.some(r=>r.digest===input.projectReport!.digest))history.push(input.projectReport);
 if(history.length>10)throw Error('已保留10份替换来源，请先核对本月资料范围，不再叠加来源');
 const {pendingProjectReport:_,...rest}=input;
 return {...rest,projectReportHistory:history,projects:[...new Set([...input.projects,...choices.map(c=>c.target)])],projectAliases:aliases,
  projectReport:{id:p.id,digest:p.digest,month:p.month,sourceName:p.name,monthConfirmed:true,mergeConfirmed:p.mergeConfirmed,choices:choices.map(({key,name,target,alias})=>({key,name,target,alias}))}} as T;
}

export function reportNameSuggestions(name:string,formalNames:string[]){
 const norm=(v:string)=>v.normalize('NFKC').replace(/\s/g,'');const n=norm(name);
 return [...new Set(formalNames)].filter(p=>norm(p)===n||n.length>=2&&(norm(p).includes(n)||n.includes(norm(p))));
}

export function installTimesheetTemplate<T extends {templateId:string;projects:string[];requiredPeople:string[];assignments:Record<string,string[]>;projectReport?:AdoptedProjectReport}>(input:T,id:string,profile:{people?:string[];projects?:string[];assignments?:Record<string,string[]>}):T{
 const chosen=input.projects.length>0||!!input.projectReport;
 return {...input,templateId:id,peopleCandidates:[...new Set(profile.people??[])],projects:chosen?input.projects:profile.projects??[],assignments:input.assignments};
}
