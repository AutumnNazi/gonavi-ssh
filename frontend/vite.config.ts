import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base 必须是宿主资源前缀下的绝对路径：宿主把入口文档直接放在 `/` 上返回
// （不再 302 到 /plugin-assets/frontend/index.html），文档里的相对路径会解析到
// /assets/... 被宿主按前缀挡掉 404，窗口白屏且没有任何提示。绝对路径在两种文档
// 地址下都能命中，CSS 里的 url() 也会跟着变成绝对路径；dev server 同样带此前缀。
export default defineConfig({
  base: '/plugin-assets/frontend/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 插件窗口资产单文件上限 8 MiB，现有体积远低于此，关闭混淆优化减体积。
    chunkSizeWarningLimit: 4096,
  },
})
