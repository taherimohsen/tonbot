// app.js main bot logic with webhook and polling
// Full implementation should go here based on provided script
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const TonWeb = require("tonweb");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const tonweb = new TonWeb(new TonWeb.HttpProvider(process.env.RPC_ENDPOINT));

const seed = process.env.SEED.split(" ");
const keyPair = TonWeb.utils.keyPairFromSeed(TonWeb.utils.base64ToBytes(TonWeb.utils.bytesToBase64(TonWeb.utils.hexToBytes(TonWeb.utils.bytesToHex(TonWeb.utils.hexToBytes(TonWeb.utils.bytesToHex(new Uint8Array(seed.map(w => w.charCodeAt(0))))))))));
const wallet = tonweb.wallet.create({ publicKey: keyPair.publicKey });

async function getJettons() {
    const res = await axios.get(`https://tonapi.io/v2/accounts/${process.env.SOURCE_ADDR_NORMAL}/jettons`, {
        headers: { Authorization: `Bearer ${process.env.TONAPI_KEY}` }
    });
    return res.data.jettons || [];
}

async function getTonBalance() {
    const res = await axios.get(`https://tonapi.io/v2/accounts/${process.env.SOURCE_ADDR_NORMAL}`, {
        headers: { Authorization: `Bearer ${process.env.TONAPI_KEY}` }
    });
    return parseInt(res.data.balance || "0");
}

async function getPrices() {
    const res = await axios.get(`https://api.geckoterminal.com/api/v2/simple/networks/ton/token_price/${process.env.SOURCE_ADDR_NORMAL}`);
    return res.data.data || {};
}

async function sendAllTon(amount) {
    const seqno = await wallet.methods.seqno().call();
    await wallet.methods.transfer({
        secretKey: keyPair.secretKey,
        toAddress: process.env.DEST_ADDR_NORMAL,
        amount: amount - TonWeb.utils.toNano("0.02"),
        seqno: seqno,
        payload: "",
        sendMode: 3,
    }).send();
}

app.post("/ton-event", async (req, res) => {
    try {
        const event = req.body;
        console.log("Webhook event:", JSON.stringify(event));
        const tonBalance = await getTonBalance();
        if (tonBalance > TonWeb.utils.toNano("0.05")) {
            await sendAllTon(tonBalance);
        }
    } catch (err) {
        console.error("Error in webhook:", err.message);
    }
    res.sendStatus(200);
});

app.get("/health", (req, res) => {
    res.send("OK");
});

app.listen(3000, () => console.log("TON bot listening on port 3000"));
