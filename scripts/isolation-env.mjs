import {resolve,join} from 'node:path';
export function isolationEnv(root, extra={}) {
 root=resolve(root);
 return {...process.env,WORKBENCH_ISOLATION_ROOT:root,WORKBENCH_TEST_MODE:'1',
 WORKBENCH_DB:join(root,'runtime/workbench.db'),WORKBENCH_TEST_DB:join(root,'runtime/workbench.db'),
 WORKBENCH_DATA_DIR:join(root,'files'),WORKBENCH_RUNTIME_DIR:join(root,'runtime'),
 WORKBENCH_WEB_DIST:join(root,'web'),WORKBENCH_BACKUP_DIR:join(root,'backups'),
 WORKBENCH_BACKUP_AUTO:'0',WORKBENCH_TESSDATA_DIR:join(root,'runtime/tessdata'),...extra};
}
