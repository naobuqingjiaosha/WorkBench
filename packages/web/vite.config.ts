import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import { loadRuntimeLayout, defaultHome } from '../server/src/core/runtime-layout.ts';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Refuse replacing the frontend underneath an existing daily backend.
const root=resolve(import.meta.dirname,'../..');
const outArg=process.argv.indexOf('--outDir');
const output=outArg>=0?resolve(process.cwd(),process.argv[outArg+1]!):resolve(root,'packages/web/dist');
const lock=process.argv.includes('build')&&output.toLowerCase()===resolve(root,'packages/web/dist').toLowerCase()?resolve(loadRuntimeLayout(root).runtimeRoot,'server.lock'):null;
if(lock&&existsSync(lock)){
 const pid=Number(readFileSync(lock,'utf8').trim());let alive=true;
 try{if(!Number.isSafeInteger(pid)||pid<=0)throw Error('无法核实服务锁');process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw e;}
 if(alive)throw Error('日常服务仍在运行，禁止覆盖 dist。请运行 npm run build -- --outDir <独立构建目录>，取得发布确认后配套切换。');
}
const devLayout=process.argv.includes('build')?null:loadRuntimeLayout(root,{
  LOCALAPPDATA:process.env.LOCALAPPDATA,XDG_DATA_HOME:process.env.XDG_DATA_HOME,
  WORKBENCH_PROFILE:'development',
  WORKBENCH_HOME:process.env.WORKBENCH_DEV_HOME||defaultHome(root,'development'),
  PORT:process.env.WORKBENCH_DEV_PORT||'18889',
});
const devTarget=`http://127.0.0.1:${devLayout?.port||18889}`;
export default defineConfig({
  plugins: [react(), {
    name:'workbench-development-boundary',
    configureServer(server) {
      server.middlewares.use(async (req,res,next) => {
        if (!/^\/(api|files)(\/|\?|$)/.test(req.url||'')) return next();
        try {
          const response=await fetch(devTarget+'/api/health',{signal:AbortSignal.timeout(2000)});
          const health=await response.json();
          if(!response.ok||health.data?.runtimeProfile!=='development'||!health.data?.dbFile||resolve(health.data.dbFile).toLowerCase()!==devLayout?.dbFile.toLowerCase()) throw Error('wrong environment');
          next();
        } catch {
          res.statusCode=503;res.setHeader('Content-Type','application/json; charset=utf-8');
          res.end(JSON.stringify({ok:false,error:{code:'DEVELOPMENT_BACKEND_REQUIRED',message:'开发后端未就绪或环境不匹配，请运行 npm run dev；已阻止向其他数据库发送请求。'}}));
        }
      });
    },
  }],
  server: {
    port: 5273,
    strictPort: true,
    proxy: { '/api': devTarget, '/files': devTarget },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
