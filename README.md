# Buildbond

Coins that pay for their own app, on Robinhood Chain. A coin is launched on Pons with a one-paragraph brief and its own
vault as the creator fee recipient. Harvests split every fee 60 / 25 / 15: the agent's build budget, a $BOND buy-and-burn,
the launcher. An AI agent builds the app on a GitHub Actions machine, checks it in headless Chrome, publishes it to
GitHub Pages and bills the vault for model usage with a receipt whose hash is on chain.

- `contracts/` BondFactory and BondVault, `node build.mjs`, `node test.mjs` (fork of mainnet, real Pons), `node devchain.mjs`
- `api/` tick (keeper), log (agent log, receipts, bill and ship), state, kv (shared store for apps), img (logos)
- `builder/` the agent (`agent.mjs`) and the check (`check.mjs`)
- `.github/workflows/builder.yml` every 10 minutes once the factory is deployed
- `sdk.js` what every app includes

Vercel env: BUILDBOND_KEEPER_KEY (the builder wallet), CRON_SECRET, BUILD_SECRET, KV_REST_API_URL / KV_REST_API_TOKEN.
GitHub secrets: CRON_SECRET, BUILD_SECRET, GEMINI_API_KEY.

Local: `node contracts/devchain.mjs`, then `node dev.mjs` with BB_DEV_RPC, BUILDBOND_FACTORY, BB_MEMORY=1 and the secrets
set; `GEMINI_MOCK=1 node builder/agent.mjs job.json pages` runs the whole loop without a model key.
