import { cron } from "@elysiajs/cron";
import { Elysia } from "elysia";

import { config, configReady } from "./config.ts";
import { isSweepRunning, runSweep } from "./job.ts";
import { log } from "./log.ts";
import { burnsPayload, readBurnRows, readBurnsCsv } from "./store.ts";

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "accept, content-type",
    "cache-control": "no-store",
  };
}

function authorize(request: Request): string | null {
  const key = (process.env.SERVICE_API_KEY ?? "").trim();
  if (!key) return null;
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (token !== key) return "unauthorized";
  return null;
}

const app = new Elysia()
  .use(
    cron({
      name: "aapl-fee-sweep",
      pattern: "0 */1 * * *",
      async run() {
        if (isSweepRunning()) {
          log("cron tick skipped — sweep already running");
          return;
        }
        log("cron tick");
        await runSweep();
      },
    }),
  )
  .get("/health", () => ({ ok: true, service: "aapl-fee-cron" }))
  .get("/ready", ({ set }) => {
    const ready = configReady();
    if (!ready.ok) {
      set.status = 503;
      return { ok: false, missing: ready.missing };
    }
    const cfg = config();
    return {
      ok: true,
      feeWallet: cfg.feeWallet,
      treasury: cfg.treasury,
      paymaster: cfg.cdp.usePaymaster,
    };
  })
  .options("/burns", ({ set }) => {
    set.headers = corsHeaders();
    return "";
  })
  .options("/burns.csv", ({ set }) => {
    set.headers = corsHeaders();
    return "";
  })
  .get("/burns", async ({ set }) => {
    set.headers = corsHeaders();
    return burnsPayload(await readBurnRows());
  })
  .get("/burns.csv", async ({ set }) => {
    set.headers = {
      ...corsHeaders(),
      "content-type": "text/csv; charset=utf-8",
    };
    return readBurnsCsv();
  })
  .post("/run", async ({ request, set }) => {
    const ready = configReady();
    if (!ready.ok) {
      set.status = 503;
      return { error: "missing env", missing: ready.missing };
    }
    const denied = authorize(request);
    if (denied) {
      set.status = 401;
      return { error: denied };
    }
    if (isSweepRunning()) {
      set.status = 409;
      return { error: "already running" };
    }
    const result = await runSweep();
    if (result.error) set.status = 500;
    return result;
  });

const port = (() => {
  const ready = configReady();
  if (!ready.ok) {
    log(`starting with incomplete env (missing ${ready.missing.join(", ")}) — /ready will fail`);
    return Number(process.env.PORT ?? 3000);
  }
  return config().port;
})();

app.listen(port);
log(`aapl-fee-cron listening on :${port}`);
