const express = require("express");

const app = express();

app.use(express.json());

const PORT = 3000;

// Meta Webhook Verify Token
const VERIFY_TOKEN = "investngain_webhook_2026";

app.get("/", (req, res) => {
    res.send("Invest N Gain WhatsApp Backend is running!");
});

// Meta webhook verification
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Webhook verified successfully!");
        res.status(200).send(challenge);
    } else {
        console.log("Webhook verification failed!");
        res.sendStatus(403);
    }
});

// Receive WhatsApp webhook events
app.post("/webhook", (req, res) => {
    console.log("WhatsApp webhook received:");
    console.log(JSON.stringify(req.body, null, 2));

    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${3000}`);
});