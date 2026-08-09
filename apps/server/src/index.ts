import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { fetchEngineContract, ContractError } from "./contract.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();

  let contract;
  try {
    contract = await fetchEngineContract(config.engineUrl, config.allowEngineOffline);
  } catch (err) {
    if (err instanceof ContractError) {
      console.error(`[fatal] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const app = createApp({ config, contract });
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`MathTutor server listening on http://${info.address}:${info.port}`);
    console.log(`  engine: ${config.engineUrl} (${contract ? contract.contract_version : "OFFLINE"})`);
    console.log(`  data:   ${config.dataDir}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
