const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = "investngain_webhook_2026";
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Temporary storage for customers who reply.
// Note: data resets when the server restarts.
const repliedCustomers = new Map();

// Home page
app.get("/", (req, res) => {
    res.send("Invest N Gain WhatsApp Backend is running!");
});



 // Meta webhook verification
app.get("/webhook", (req, res) => {
    console.log("Webhook verification request received");

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    console.log("Verification mode:", mode);
    console.log("Challenge received:", Boolean(challenge));

    if (mode === "subscribe" && token === VERIFY_TOKEN && challenge) {
        console.log("Webhook verified successfully!");
        return res.status(200).send(challenge);
    }

    console.log("Webhook verification failed: mode, token, or challenge mismatch");
    return res.sendStatus(403);
});


// Receive incoming WhatsApp messages
app.post("/webhook", (req, res) => {
    try {
        const entries = req.body?.entry || [];

        for (const entry of entries) {
            for (const change of entry.changes || []) {
                const value = change.value || {};
                const messages = value.messages || [];

                for (const message of messages) {
                    const customer = message.from;

                    if (customer) {
                        repliedCustomers.set(customer, {
                            stopped: true,
                            repliedAt: new Date().toISOString(),
                            messageType: message.type
                        });

                        console.log(
                            "Customer replied; follow-up marked stopped:",
                            customer
                        );
                    }
                }
            }
        }
    } catch (error) {
        console.error("Webhook processing error:", error.message);
    }

    return res.sendStatus(200);
});

// Check whether a customer has replied
app.get("/followup-status", (req, res) => {
    const recipient = (req.query.recipient || "").replace(/\D/g, "");

    if (!recipient) {
        return res.status(400).json({
            error: "Please provide a recipient number."
        });
    }

    const record = repliedCustomers.get(recipient);

    return res.json({
        recipient,
        stopFollowUp: Boolean(record),
        details: record || null
    });
});

// Send WhatsApp text message
app.post("/send-message", async (req, res) => {
    try {
        const { recipient, message } = req.body;

        if (!recipient || !message) {
            return res.status(400).json({
                error: "recipient and message are required"
            });
        }

        if (!PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
            return res.status(500).json({
                error: "WhatsApp credentials are not configured in Render."
            });
        }

        const response = await axios.post(
            `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: recipient,
                type: "text",
                text: { body: message }
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("WhatsApp text message sent.");
        return res.status(200).json(response.data);

    } catch (error) {
        console.error(
            "Send message error:",
            error.response?.data || error.message
        );

        return res.status(500).json({
            error: error.response?.data || error.message
        });
    }
});

// Send approved WhatsApp template
app.post("/send-template", async (req, res) => {
    try {
        const { recipient } = req.body;

        if (!recipient) {
            return res.status(400).json({
                error: "recipient is required"
            });
        }

        if (!PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
            return res.status(500).json({
                error: "WhatsApp credentials are not configured in Render."
            });
        }

        const response = await axios.post(
            `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: recipient,
                type: "template",
                template: {
                    name: "lead_followup_test",
                    language: { code: "en_US" }
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("WhatsApp template message sent.");
        return res.status(200).json(response.data);

    } catch (error) {
        console.error(
            "Send template error:",
            error.response?.data || error.message
        );

        return res.status(500).json({
            error: error.response?.data || error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
