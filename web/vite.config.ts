import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.EPUBMAKER_API ?? 'http://127.0.0.1:7801';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 7800,
    strictPort: false,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // 不自动清空 dist：避免在某些环境（沙箱 safe-delete 封装）下清空目录失败而中断构建；
    // vite 会直接覆盖同名产物，残留旧文件无副作用。
    emptyOutDir: false
  }
});
