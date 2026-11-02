import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 开发时前端在 5173，后端在 8099（本机 8080 被别的服务占着）。
// 代理让浏览器看起来同源，Cookie 才正常，也省掉 CORS 中间件。
const target = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8099'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/healthz': target,
      '/t': target,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
