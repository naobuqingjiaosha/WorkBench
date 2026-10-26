import {resolve,join} from 'node:path';
// Do not inherit a daily data path, session credential or provider key into another environment.
export function cleanRuntimeEnv(source=process.env) {
 return Object.fromEntries(Object.entries(source).filter(([key])=>
  !/^WORKBENCH_|^PORT$|^HOST$|^BASE$|^NODE_ENV$|API_?KEY|ACCESS_?TOKEN|SESSION_?TOKEN|CLIENT_?SECRET/i.test(key)));
}
export function isolationEnv(root, extra={}) {
 root=resolve(root);
 return {...cleanRuntimeEnv(),...extra,WORKBENCH_PROFILE:'test',WORKBENCH_HOME:root,NODE_ENV:'test',WORKBENCH_ISOLATION_ROOT:root,WORKBENCH_TEST_MODE:'1',
 WORKBENCH_DB:join(root,'runtime/workbench.db'),WORKBENCH_TEST_DB:join(root,'runtime/workbench.db'),
 WORKBENCH_DATA_DIR:join(root,'files'),WORKBENCH_RUNTIME_DIR:join(root,'runtime'),
 WORKBENCH_WEB_DIST:join(root,'web'),WORKBENCH_BACKUP_DIR:join(root,'backups'),
 WORKBENCH_BACKUP_AUTO:'0',WORKBENCH_TESSDATA_DIR:join(root,'runtime/tessdata')};
}
