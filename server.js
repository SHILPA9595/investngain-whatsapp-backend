
const express = require("express");
const axios = require("axios");
const multer = require("multer");
const { parse } = require("csv-parse/sync");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = "investngain_webhook_2026";
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const ENABLE_BULK_SENDING =
    process.env.ENABLE_BULK_SENDING === "true";

const TEMPLATE_NAME = "property_update_investngain";
const TEMPLATE_LANGUAGE = "en_US";
const MAX_RECIPIENTS = 100;
const MESSAGE_DELAY_MS = 1000;

const repliedCustomers = new Map();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 1 * 1024 * 1024,
        files: 1
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== "text/csv" &&
            !file.originalname.toLowerCase().endsWith(".csv")) {
            return cb(new Error("Please upload a CSV file."));
        }
        cb(null, true);
    }
});

function normalizePhone(value) {
    return String(value || "").replace(/\D/g, "");
}

function validPhone(value) {
    return /^\d{10,15}$/.test(value);
}

function requireAdmin(req, res, next) {
    if (!ADMIN_API_KEY) {
        return res.status(503).json({
            error: "Bulk admin access is not configured in Render."
        });
    }

    const suppliedKey = req.get("x-admin-key");

    if (!suppliedKey || suppliedKey !== ADMIN_API_KEY) {
        return res.status(401).json({
            error: "Unauthorized."
        });
    }

    next();
}

function requireWhatsAppConfig() {
    if (!PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
        throw new Error(
            "WhatsApp credentials are not configured in Render."
        );
    }
}

async function sendTemplate(recipient) {
    requireWhatsAppConfig();

    return axios.post(
        `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: recipient,
            type: "template",
            template: {
                name: TEMPLATE_NAME,
                language: { code: TEMPLATE_LANGUAGE }
            }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                "Content-Type": "application/json"
            },
            timeout: 20000
        }
    );
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Home page
app.get("/", (req, res) => {
    res.send("Invest N Gain WhatsApp Backend is running!");
});

// Verify Meta webhook
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" &&
        token === VERIFY_TOKEN &&
        challenge) {
        console.log("Webhook verified successfully.");
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
});

// Receive WhatsApp messages and mark replies
app.post("/webhook", (req, res) => {
    try {
        const entries = req.body?.entry || [];

        for (const entry of entries) {
            for (const change of entry.changes || []) {
                const value = change.value || {};

                for (const message of value.messages || []) {
                    const customer = normalizePhone(message.from);

                    if (customer) {
                        repliedCustomers.set(customer, {
                            stopped: true,
                            repliedAt: new Date().toISOString(),
                            messageType: message.type
                        });

                        console.log(
                            "Customer reply recorded; follow-up stopped."
                        );
                    }
                }
            }
        }
    } catch (error) {
        console.error("Webhook processing error:", error.message);
    }

    // Meta expects a quick acknowledgement.
    return res.sendStatus(200);
});

// Check whether a customer has replied
app.get("/followup-status", (req, res) => {
    const recipient = normalizePhone(req.query.recipient);

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

// Send a normal text message
app.post("/send-message", async (req, res) => {
    try {
        const recipient = normalizePhone(req.body.recipient);
        const message = String(req.body.message || "").trim();

        if (!validPhone(recipient) || !message) {
            return res.status(400).json({
                error: "A valid recipient number and message are required."
            });
        }

        requireWhatsAppConfig();

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
                },
                timeout: 20000
            }
        );

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

// Send one approved template
app.post("/send-template", async (req, res) => {
    try {
        const recipient = normalizePhone(req.body.recipient);

        if (!validPhone(recipient)) {
            return res.status(400).json({
                error: "A valid recipient number is required."
            });
        }

        const response = await sendTemplate(recipient);
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

// Bulk template send from CSV.
// Disabled unless ENABLE_BULK_SENDING=true in Render.
// Requires x-admin-key and a CSV with phone,consent columns.
app.post(
    "/bulk-template",
    requireAdmin,
    upload.single("file"),
    async (req, res) => {
        if (!ENABLE_BULK_SENDING) {
            return res.status(403).json({
                error: "Bulk sending is disabled. Enable it only after the template is approved and testing is complete."
            });
        }

        if (!req.file) {
            return res.status(400).json({
                error: "Upload a CSV file in the 'file' field."
            });
        }

        let rows;

        try {
            rows = parse(req.file.buffer, {
                columns: true,
                skip_empty_lines: true,
                trim: true,
                bom: true
            });
        } catch (error) {
            return res.status(400).json({
                error: "Could not read CSV. Check the file format."
            });
        }

        if (!rows.length) {
            return res.status(400).json({
                error: "The CSV contains no client rows."
            });
        }

        const headers = Object.keys(rows[0]).map(h =>
            h.trim().toLowerCase()
        );

        if (!headers.includes("phone") ||
            !headers.includes("consent")) {
            return res.status(400).json({
                error: "CSV must contain phone and consent columns."
            });
        }

        // Validate the entire list before sending anything.
        const seen = new Set();
        const recipients = [];
        let skipped = 0;

        for (const row of rows) {
            const normalizedRow = {};

            for (const [key, value] of Object.entries(row)) {
                normalizedRow[key.trim().toLowerCase()] = value;
            }

            const phone = normalizePhone(normalizedRow.phone);
            const consent = String(
                normalizedRow.consent || ""
            ).trim().toLowerCase();

            const optedIn = [
                "yes", "true", "1"
            ].includes(consent);

            if (!validPhone(phone) || !optedIn || seen.has(phone)) {
                skipped++;
                continue;
            }

            seen.add(phone);
            recipients.push(phone);
        }

        if (recipients.length > MAX_RECIPIENTS) {
            return res.status(400).json({
                error: `Maximum ${MAX_RECIPIENTS} recipients per CSV. Split the list into smaller batches.`,
                eligible: recipients.length,
                skipped
            });
        }

        if (!recipients.length) {
            return res.status(400).json({
                error: "No valid, opted-in, unique recipients found.",
                skipped
            });
        }

        try {
            requireWhatsAppConfig();
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }

        const results = [];

        for (let i = 0; i < recipients.length; i++) {
            const recipient = recipients[i];

            // If this process has received a reply from this customer,
            // do not send an automated follow-up.
            if (repliedCustomers.has(recipient)) {
                results.push({
                    recipient,
                    status: "skipped",
                    reason: "Customer has replied"
                });
                skipped++;
                continue;
            }

            try {
                const response = await sendTemplate(recipient);

                results.push({
                    recipient,
                    status: "accepted_by_meta",
                    messageId: response.data?.messages?.[0]?.id || null
                });
            } catch (error) {
                results.push({
                    recipient,
                    status: "failed",
                    error:
                        error.response?.data?.error?.message ||
                        error.message
                });
            }

            if (i < recipients.length - 1) {
                await delay(MESSAGE_DELAY_MS);
            }
        }

        const accepted = results.filter(
            result => result.status === "accepted_by_meta"
        ).length;
        const failed = results.filter(
            result => result.status === "failed"
        ).length;

        return res.status(200).json({
            totalProcessed: results.length,
            acceptedByMeta: accepted,
            failed,
            skipped,
            note: "Accepted by Meta does not guarantee delivery. Check message status webhooks for delivery results.",
            results
        });
    }
);

// Multer errors and upload errors
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        return res.status(400).json({
            error: "CSV upload failed or file is too large (max 1 MB)."
        });
    }

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    next();
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
