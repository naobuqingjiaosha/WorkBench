/** npm 11 adapter: read config in the checkout, operate only on the prepared copy.
 * No npmrc/config values are copied, serialized or placed in command arguments.
 * Keep npm's own project/user/environment precedence and credential filtering.
 */
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {assertNoPathLinks} from '../packages/server/src/core/path-boundary.ts';

const [cli,target,...args]=process.argv.slice(2),checkout=process.cwd();
let npm;
try {
 const require=createRequire(cli),npmRoot=dirname(dirname(cli));
 const pkg=require(resolve(npmRoot,'package.json'));
 if(pkg.name!=='npm'||!/^11\./.test(pkg.version))throw Error('unsupported npm');
 if(!['ci','ls'].includes(args[0]))throw Error('unsupported command');
 assertNoPathLinks(target);
 require('graceful-fs').gracefulify(require('node:fs'));
 // npm parses paths (including cafile/cache/userconfig) against the original cwd.
 process.argv=[process.execPath,cli,...args];
 const Npm=require(resolve(npmRoot,'lib/npm.js'));npm=new Npm();
 const loaded=await npm.load();
 if(!loaded.exec||npm.global||resolve(npm.localPrefix)!==checkout)throw Error('unexpected npm root');
 // Config has finished loading. Redirect installation and workspace discovery,
 // without replacing the original project or user config layers.
 npm.config.localPrefix=resolve(target);npm.config.cwd=resolve(target);
 process.chdir(target);npm.config.setEnvs();
 if(npm.prefix!==resolve(target))throw Error('unexpected install root');
 await npm.exec(loaded.command,loaded.args);
} catch (error) {
 // npm renders its own redacted diagnostics; never serialize config/error objects here.
 const code=/^[A-Z][A-Z0-9_]{1,40}$/.test(error?.code)?error.code:'NPM_PREPARE_FAILED';
 process.send?.({type:'npm-failure',code});
 console.error('npm依赖准备/检查失败（'+code+'）。需要Node.js 24配套的npm 11；请核对依赖、npm配置及网络。');
 process.exitCode=1;
} finally {npm?.unload();}
