const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const PORT = 3000;

// Meta Webhook Verify Token
const VERIFY_TOKEN = "investngain_webhook_2026";

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = "1400740626455918";

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

// Send WhatsApp text message
app.post("/send-message", async (req, res) => {
    try {
        const { recipient, message } = req.body;

        const response = await axios.post(
            `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: recipient,
                type: "text",
                text: {
                    body: message
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("WhatsApp message sent:", response.data);

        res.status(200).json(response.data);

    } catch (error) {
        console.error(
            "WhatsApp message error:",
            error.response?.data || error.message
        );

        res.status(500).json({
            error: error.response?.data || error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${3000}`);
});