import { defineConfig } from 'vite';

/**
 * 部署到子路径时用 VITE_BASE_PATH 覆盖，例如：
 *   VITE_BASE_PATH=/ npm run build
 * 生产默认就是 /speed/（qlili.com/speed），本地 dev 始终是 /。
 */
export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE_PATH ?? (command === 'build' ? '/speed/' : '/'),
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
