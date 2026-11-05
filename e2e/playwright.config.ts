import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

/** 冒烟专用的端口：不跟日常调试用的 8080/5173 抢，跑完不影响正在开着的开发环境 */
const GATEWAY_PORT = 8099
const WEB_PORT = 5199
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`

/**
 * 一次冒烟 = 一整套真栈：真网关（引擎离线降级、独立沙箱 DB）+ 真前端。
 * 不 stub 接口：stub 过的冒烟只能证明"组件能渲染"，证明不了"这个视图在这套数据下不会崩"。
 */
export default defineConfig({
  testDir: './tests',
  // 共享一个沙箱库与一条网关：并行只会让失败现场变模糊
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'report' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: WEB_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },

  projects: [
    // 先建家长账号并登录一次，把会话 cookie 存下来；后面的用例直接带着它跑
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'smoke',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: path.join(here, '.auth', 'parent.json') },
    },
  ],

  webServer: [
    {
      // 沙箱准备必须在网关启动之前：网关一启动就把 app.sqlite 锁住了
      command: `node e2e/prepare-sandbox.mjs && node apps/server/dist/index.js`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${GATEWAY_PORT}/api/v1/auth/state`,
      env: {
        SERVER_PORT: String(GATEWAY_PORT),
        SERVER_HOST: '127.0.0.1',
        ALLOW_ENGINE_OFFLINE: '1',
        // 指一个必然没有服务的端口：冒烟只验"引擎不在时页面还好好的"。
        // 指向 8000 会撞上开发机上别的东西（ALLOW_ENGINE_OFFLINE 只管"连不上"，
        // 连上了但契约 404 仍然会让网关拒绝启动）。
        ENGINE_URL: 'http://127.0.0.1:8799',
        DATA_DIR: './data/.e2e',
      },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter frontend dev',
      cwd: repoRoot,
      url: WEB_ORIGIN,
      env: {
        SERVER_PORT: String(GATEWAY_PORT),
        WEB_PORT: String(WEB_PORT),
        WEB_HOST: '127.0.0.1',
      },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
