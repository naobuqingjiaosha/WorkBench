import { bootstrap } from '../core/bootstrap.ts';
import { closeDatabase } from '../db/index.ts';
bootstrap();
console.log('已补齐缺失的预置数据，保留已有设置。');
closeDatabase();
