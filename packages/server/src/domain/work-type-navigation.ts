/** 展示目录，不参与领域、编号、阶段或历史快照。未知项目保留待确认入口。 */
export type NavigationGroup = 'information' | 'engineering' | 'administration';
type TypeSource = { code: string; name: string; domain: string; category: string; description: string | null; navigation_group?: NavigationGroup | null };

export function workTypeNavigation(t: TypeSource) {
  let group: NavigationGroup | null = t.domain === 'admin' ? 'administration' : t.navigation_group ?? null;
  if (t.domain === 'project' && !group) {
    if (['信息化项目','信息化类','信息化类项目','软件研发','系统集成','信息技术服务'].includes(t.category)) group = 'information';
    else if (['工程项目','工程类','工程类项目','工程施工','工程安装','工程技术服务'].includes(t.category)) group = 'engineering';
    // 既有 svc 配置明确说明并入信息化管理；不按“服务”字样猜测自定义类型。
    else if (t.code === 'svc' && t.description?.includes('并入信息化类管理')) group = 'information';
  }
  const aliases: Record<string, [string, string]> = { eng: ['工程类项目','通用工程流程'], info: ['信息化类项目','通用信息化流程'] };
  const alias = aliases[t.code];
  const purposes: Record<string,string> = {
    'software-project': '适用于软件需求、研发、测试与交付。',
    'integration-project': '适用于设备采购、系统部署与联调交付。',
    eng: '适用于有监理、需承包人／监理／发包人共同办理的通用工程流程。',
    info: '适用于设备到货、安装调试、试运行和移交的通用信息化流程。',
    svc: '现有配置用于无设备环节的纯服务交付、验收与结算。',
  };
  return { navigation_group: group, display_name: alias?.[0] === t.name ? alias[1] : t.name, usage_hint: purposes[t.code] ?? t.description ?? '' };
}
