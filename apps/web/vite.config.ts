import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 仓库根目录：与引擎/网关共享同一份根 .env（envDir 指过去后，
// VITE_* 变量也从根 .env 暴露给客户端代码）
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '')
  // 代理默认指向网关（对外唯一入口；练习/诊断/讲解等路由都在网关上）。
  // 网关端口跟随 SERVER_PORT；特殊场景可用 VITE_API_PROXY 整体覆盖。
  const proxyTarget = env.VITE_API_PROXY || `http://localhost:${env.SERVER_PORT || '8080'}`

  return {
    envDir: repoRoot,
    plugins: [react(), tailwindcss()],
    server: {
      // 平板/手机经局域网访问开发服务器；WEB_HOST=127.0.0.1 可收回仅本机
      host: env.WEB_HOST || '0.0.0.0',
      port: Number(env.WEB_PORT || 5173),
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
