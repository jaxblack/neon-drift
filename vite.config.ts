import { defineConfig } from 'vite';

/**
 * 部署到子路径时用 VITE_BASE_PATH 覆盖，例如：
 *   VITE_BASE_PATH=speed npm run build   -> base = /speed/
 *   VITE_BASE_PATH= npm run build        -> base = /
 * 不设置时：build 默认 /speed/（qlili.com/speed），dev 始终 /。
 *
 * 传值时**不要带前导斜杠**：Git Bash (MSYS) 会把以 / 开头的环境变量当成 POSIX 路径，
 * 自动展开成 `C:/Program Files/Git/speed` —— 那样构建出来的资源路径线上必然 404。
 * 下面的 resolveBase 会把这层污染剥掉兜底，但传裸名字最稳。
 */
function resolveBase(raw: string | undefined, isBuild: boolean): string {
  if (raw === undefined) return isBuild ? '/speed/' : '/';
  let v = raw.trim().replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(v) || v.includes('/Git/')) {
    v = v.split('/').filter(Boolean).pop() ?? '';
  }
  const segs = v.split('/').filter(Boolean);
  return segs.length ? `/${segs.join('/')}/` : '/';
}

export default defineConfig(({ command }) => ({
  base: resolveBase(process.env.VITE_BASE_PATH, command === 'build'),
  server: {
    port: 5180,
    host: true,
    // 未来接腾讯云服务器时，把 /api 与 /ws 代理到本地 server/index.mjs
    proxy: {
      '/api': { target: 'http://localhost:8090', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8090', ws: true },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
}));
