import type { WorkType } from './api';
export type NavigationGroup = NonNullable<WorkType['navigation_group']>;
export const TYPE_GROUPS: {value: NavigationGroup; label: string}[] = [
  {value:'information',label:'信息化项目'},
  {value:'engineering',label:'工程项目'},
  {value:'administration',label:'行政管理'},
];
