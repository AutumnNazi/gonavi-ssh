import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base 用相对路径：插件窗口从包内文件路径加载，没有固定站点根。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 插件窗口资产单文件上限 8 MiB，现有体积远低于此，关闭混淆优化减体积。
    chunkSizeWarningLimit: 4096,
  },
})
