export interface ServerConfig {
  /** server 监听端口（对外唯一入口；平板经局域网访问） */
  port: number;
  /** 监听地址：默认 0.0.0.0 以支持局域网/平板访问 */
  host: string;
  /** Python 讲解引擎地址（内网，学生设备永不直连） */
  engineUrl: string;
  /** data/ 唯一数据根 */
  dataDir: string;
  /** 引擎离线时是否允许降级启动（开发用；生产按设计应拒绝启动） */
  allowEngineOffline: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.SERVER_PORT ?? 8080),
    host: env.SERVER_HOST ?? "0.0.0.0",
    engineUrl: (env.ENGINE_URL ?? "http://localhost:8000").replace(/\/$/, ""),
    dataDir: env.DATA_DIR ?? new URL("../../../data", import.meta.url).pathname,
    allowEngineOffline: env.ALLOW_ENGINE_OFFLINE === "1",
  };
}
