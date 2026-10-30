
const express = require("express");
const axios = require("axios");
const multer = require("multer");
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");

const app = express();

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN =
    process.env.VERIFY_TOKEN || "investngain_webhook_2026";

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const META_APP_SECRET = process.env.META_APP_SECRET;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const ENABLE_BULK_SENDING =
    process.env.ENABLE_BULK_SENDING === "true";

const TEMPLATE_NAME = "property_update_investngain";
const TEMPLATE_LANGUAGE = "en";

const MAX_RECIPIENTS = 100;
const MESSAGE_DELAY_MS = 1000;

// --------------------------------------------------
// EXPRESS CONFIGURATION
// --------------------------------------------------

// Preserve the original request body for Meta signature verification.

app.use(
    express.json({
        limit: "1mb",
        verify: (req, res, buffer) => {
            req.rawBody = Buffer.from(buffer);
        }
    })
);

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function normalizePhone(value) {
    return String(value || "").replace(/\D/g, "");
}

function validPhone(value) {
    return /^\d{10,15}$/.test(value);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function requireAdmin(req, res, next) {
    if (!ADMIN_API_KEY) {
        return res.status(503).json({
            error: "ADMIN_API_KEY is not configured."
        });
    }

    const suppliedKey = req.get("x-admin-key");

    if (!suppliedKey) {
        return res.status(401).json({
            error: "Admin key required."
        });
    }

    const expected = Buffer.from(ADMIN_API_KEY);
    const supplied = Buffer.from(suppliedKey);

    if (
        expected.length !== supplied.length ||
        !crypto.timingSafeEqual(expected, supplied)
    ) {
        return res.status(401).json({
            error: "Unauthorized."
        });
    }

    next();
}

function requireWhatsAppConfig() {
    if (!PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
        throw new Error(
            "WhatsApp credentials are missing in Render."
        );
    }
}

function requireSupabaseConfig() {
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
        throw new Error(
            "Supabase environment variables are missing."
        );
    }
}

// --------------------------------------------------
// SUPABASE DATABASE
// --------------------------------------------------

function supabaseHeaders(extra = {}) {
    requireSupabaseConfig();

    return {
        apikey: SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
        ...extra
    };
}

function supabaseTableUrl() {
    requireSupabaseConfig();

    return (
        SUPABASE_URL.replace(/\/$/, "") +
        "/rest/v1/whatsapp_leads"
    );
}

async function saveLeadToDatabase(customer, record) {
    await axios.post(
        `${supabaseTableUrl()}?on_conflict=phone`,
        {
            phone: customer,
            lead_status: record.leadStatus,
            stop_followup: record.stopped,
            last_message_type: record.messageType,
            last_reply_at: record.repliedAt,
            updated_at: new Date().toISOString()
        },
        {
            headers: supabaseHeaders({
                Prefer: "resolution=merge-duplicates"
            }),
            timeout: 10000
        }
    );
}

async function getLeadFromDatabase(customer) {
    const response = await axios.get(
        supabaseTableUrl(),
        {
            params: {
                phone: `eq.${customer}`,
                select:
                    "phone,lead_status,stop_followup,last_message_type,last_reply_at",
                limit: 1
            },
            headers: supabaseHeaders(),
            timeout: 10000
        }
    );

    const lead = response.data?.[0];

    if (!lead) {
        return null;
    }

    return {
        stopped: lead.stop_followup,
        repliedAt: lead.last_reply_at,
        messageType: lead.last_message_type,
        leadStatus: lead.lead_status
    };
}

// --------------------------------------------------
// LEAD CLASSIFICATION
// --------------------------------------------------

function classifyLead(message) {
    const text = String(
        message.text?.body ||
        message.button?.text ||
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title ||
        ""
    )
        .trim()
        .toLowerCase();

    if (
        /\b(not interested|no thanks|stop|unsubscribe)\b/.test(text)
    ) {
        return "NOT_INTERESTED";
    }

    if (
        /\b(call back|callback|call me|later|tomorrow)\b/.test(text)
    ) {
        return "CALL_BACK";
    }

    if (
        /\b(interested|yes|details|price|site visit)\b/.test(text)
    ) {
        return "INTERESTED";
    }

    return "NEEDS_REVIEW";
}

// --------------------------------------------------
// META WEBHOOK SECURITY
// --------------------------------------------------

function verifyMetaSignature(req, res, next) {
    console.log("WEBHOOK RECEIVED");

    if (!META_APP_SECRET) {
        console.log(
            "WEBHOOK REJECTED: App secret missing"
        );

        return res.sendStatus(503);
    }

    const signature = req.get("x-hub-signature-256");

    if (
        !signature ||
        !/^sha256=[a-f0-9]{64}$/i.test(signature)
    ) {
        console.log(
            "WEBHOOK REJECTED: Signature missing or invalid format"
        );

        return res.sendStatus(403);
    }

    if (!req.rawBody) {
        console.log(
            "WEBHOOK REJECTED: Raw body missing"
        );

        return res.sendStatus(403);
    }

    const expected =
        "sha256=" +
        crypto
            .createHmac("sha256", META_APP_SECRET)
            .update(req.rawBody)
            .digest("hex");

    const suppliedBuffer = Buffer.from(
        signature.toLowerCase()
    );

    const expectedBuffer = Buffer.from(expected);

    if (
        suppliedBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(
            suppliedBuffer,
            expectedBuffer
        )
    ) {
        console.log(
            "WEBHOOK REJECTED: Signature mismatch"
        );

        return res.sendStatus(403);
    }

    console.log("WEBHOOK SIGNATURE VERIFIED");

    next();
}

// --------------------------------------------------
// CSV UPLOAD CONFIGURATION
// --------------------------------------------------

const upload = multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: 1024 * 1024,
        files: 1
    },

    fileFilter: (req, file, cb) => {
        if (
            file.mimetype !== "text/csv" &&
            !file.originalname.toLowerCase().endsWith(".csv")
        ) {
            return cb(
                new Error("Please upload a CSV file.")
            );
        }

        cb(null, true);
    }
});

// --------------------------------------------------
// WHATSAPP TEMPLATE SENDING
// --------------------------------------------------

async function sendTemplate(
    recipient,
    templateName = TEMPLATE_NAME,
    customerName = "Customer"
) {
    requireWhatsAppConfig();

    const allowedTemplates = [
      "investngain_day1_followup",
      "investngain_day3_followup",
      "_investngain_day7_followup",
"hello_world",
        "property_update_investngain",
        "lead_followup_test",
        "new_utility_temp",
        "utility_by_harsh",
        "by_harsh_2"
    ];

    if (!allowedTemplates.includes(templateName)) {
        throw new Error("Template is not allowed.");
    }

    const template = {
        name: templateName,
        language: {
            code: TEMPLATE_LANGUAGE
        }
    };

    // by_harsh_2 requires one body variable.

    if (templateName === "by_harsh_2") {
        template.components = [
            {
                type: "body",
                parameters: [
                    {
                        type: "text",
                        text: String(customerName || "Customer")
                    }
                ]
            }
        ];
    }

    return axios.post(
        `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: recipient,
            type: "template",
            template
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

// --------------------------------------------------
// HOME ROUTE
// --------------------------------------------------

app.get("/", (req, res) => {
    res.send(
        "Invest N Gain WhatsApp Backend is running!"
    );
});

// --------------------------------------------------
// META WEBHOOK VERIFICATION
// --------------------------------------------------

app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (
        mode === "subscribe" &&
        token === VERIFY_TOKEN &&
        challenge
    ) {
        console.log(
            "Webhook verified successfully."
        );

        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
});

// --------------------------------------------------
// RECEIVE CUSTOMER REPLIES
// --------------------------------------------------

app.post(
    "/webhook",
    verifyMetaSignature,

    async (req, res) => {
        try {
            console.log(
                "WEBHOOK DEBUG:",
                Object.keys(req.body || {})
            );

            const entries = req.body?.entry || [];

            console.log(
                "WEBHOOK ENTRY COUNT:",
                entries.length
            );

            for (const entry of entries) {
                for (const change of entry.changes || []) {
                    const value = change.value || {};

                    const messages = value.messages || [];

                    console.log(
                        "WEBHOOK MESSAGE COUNT:",
                        messages.length
                    );

                    for (const message of messages) {
                        const customer = normalizePhone(
                            message.from
                        );

                        if (!validPhone(customer)) {
                            console.log(
                                "WEBHOOK SKIPPED: Invalid sender format"
                            );

                            continue;
                        }

                        const leadStatus = classifyLead(message);

                        const record = {
                            stopped: true,
                            repliedAt:
                                new Date().toISOString(),

                            messageType: message.type,
                            leadStatus
                        };

                        await saveLeadToDatabase(
                            customer,
                            record
                        );

                        console.log(
                            "Customer reply saved in Supabase:",
                            leadStatus
                        );
                    }
                }
            }

            return res.sendStatus(200);

        } catch (error) {
            console.error(
                "Webhook processing error:",
                error.response?.data || error.message
            );

            // Do not acknowledge a failed database write.
            // Meta may retry the webhook.

            return res.sendStatus(500);
        }
    }
);

// --------------------------------------------------
// FOLLOW-UP STATUS
// --------------------------------------------------

app.get(
    "/followup-status",
    requireAdmin,

    async (req, res) => {
        try {
            const recipient = normalizePhone(
                req.query.recipient
            );

            if (!validPhone(recipient)) {
                return res.status(400).json({
                    error:
                        "Provide a valid recipient number."
                });
            }

            const record =
                await getLeadFromDatabase(recipient);

            return res.json({
                recipient,
                stopFollowUp:
                    Boolean(record?.stopped),

                details: record
            });

        } catch (error) {
            console.error(
                "Follow-up status error:",
                error.response?.data || error.message
            );

            return res.status(500).json({
                error:
                    "Could not retrieve lead status."
            });
        }
    }
);

// --------------------------------------------------
// SEND NORMAL MESSAGE
// --------------------------------------------------

app.post(
    "/send-message",
    requireAdmin,

    async (req, res) => {
        try {
            const recipient = normalizePhone(
                req.body.recipient
            );

            const message = String(
                req.body.message || ""
            ).trim();

            if (
                !validPhone(recipient) ||
                !message
            ) {
                return res.status(400).json({
                    error:
                        "Valid recipient and message are required."
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

                    text: {
                        body: message
                    }
                },
                {
                    headers: {
                        Authorization:
                            `Bearer ${WHATSAPP_ACCESS_TOKEN}`,

                        "Content-Type":
                            "application/json"
                    },

                    timeout: 20000
                }
            );

            return res.status(200).json(
                response.data
            );

        } catch (error) {
            console.error(
                "Send message error:",
                error.response?.data || error.message
            );

            return res.status(500).json({
                error:
                    error.response?.data || error.message
            });
        }
    }
);

// --------------------------------------------------
// SEND ONE TEMPLATE
// --------------------------------------------------

app.post(
    "/send-template",
    requireAdmin,

    async (req, res) => {
        try {
            const recipient = normalizePhone(
                req.body.recipient
            );

            if (!validPhone(recipient)) {
                return res.status(400).json({
                    error:
                        "Valid recipient number required."
                });
            }

            // Respect permanent follow-up stop status.

            const lead =
                await getLeadFromDatabase(recipient);

            if (lead?.stopped) {
                return res.status(409).json({
                    error:
                        "Customer has already replied.",

                    leadStatus: lead.leadStatus
                });
            }

            const response =
                await sendTemplate(recipient);

            return res.status(200).json(
                response.data
            );

        } catch (error) {
            console.error(
                "Send template error:",
                error.response?.data || error.message
            );

            return res.status(500).json({
                error:
                    error.response?.data || error.message
            });
        }
    }
);

// --------------------------------------------------
// BULK TEMPLATE SENDING
// --------------------------------------------------

app.post(
    "/bulk-template",
    requireAdmin,
    upload.single("file"),

    async (req, res) => {
        if (!ENABLE_BULK_SENDING) {
            return res.status(403).json({
                error:
                    "Bulk sending is disabled in Render."
            });
        }

        if (!req.file) {
            return res.status(400).json({
                error:
                    "Upload CSV in the 'file' field."
            });
        }

        let rows;

        try {
            rows = parse(
                req.file.buffer,
                {
                    columns: true,
                    skip_empty_lines: true,
                    trim: true,
                    bom: true
                }
            );

        } catch (error) {
            return res.status(400).json({
                error:
                    "Invalid CSV format."
            });
        }

        if (!rows.length) {
            return res.status(400).json({
                error:
                    "CSV has no customer rows."
            });
        }

        const headers = Object.keys(
            rows[0]
        ).map(
            header =>
                header.trim().toLowerCase()
        );

        if (
            !headers.includes("phone") ||
            !headers.includes("consent")
        ) {
            return res.status(400).json({
                error:
                    "CSV must contain phone and consent columns."
            });
        }

        const seen = new Set();
        const recipients = [];

        let skipped = 0;

        for (const row of rows) {
            const normalizedRow = {};

            for (
                const [key, value]
                of Object.entries(row)
            ) {
                normalizedRow[
                    key.trim().toLowerCase()
                ] = value;
            }

            const phone = normalizePhone(
                normalizedRow.phone
            );

            const consent = String(
                normalizedRow.consent || ""
            )
                .trim()
                .toLowerCase();

            const optedIn = [
                "yes",
                "true",
                "1"
            ].includes(consent);

            if (
                !validPhone(phone) ||
                !optedIn ||
                seen.has(phone)
            ) {
                skipped++;
                continue;
            }

            seen.add(phone);
            recipients.push(phone);
        }

        if (
            recipients.length >
            MAX_RECIPIENTS
        ) {
            return res.status(400).json({
                error:
                    `Maximum ${MAX_RECIPIENTS} recipients allowed.`,

                eligible: recipients.length,
                skipped
            });
        }

        if (!recipients.length) {
            return res.status(400).json({
                error:
                    "No valid opted-in recipients.",

                skipped
            });
        }

        try {
            requireWhatsAppConfig();
            requireSupabaseConfig();

        } catch (error) {
            return res.status(503).json({
                error: error.message
            });
        }

        const results = [];

        for (
            let i = 0;
            i < recipients.length;
            i++
        ) {
            const recipient = recipients[i];

            let lead;

            try {
                lead =
                    await getLeadFromDatabase(
                        recipient
                    );

            } catch (error) {
                results.push({
                    recipient,
                    status: "skipped",

                    reason:
                        "Database status could not be checked"
                });

                skipped++;
                continue;
            }

            if (lead?.stopped) {
                results.push({
                    recipient,
                    status: "skipped",

                    reason:
                        "Customer has already replied"
                });

                skipped++;
                continue;
            }

            try {
                const response =
                    await sendTemplate(recipient);

                results.push({
                    recipient,
                    status:
                        "accepted_by_meta",

                    messageId:
                        response.data?.messages?.[0]?.id ||
                        null
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

            if (
                i <
                recipients.length - 1
            ) {
                await delay(
                    MESSAGE_DELAY_MS
                );
            }
        }

        const accepted = results.filter(
            item =>
                item.status ===
                "accepted_by_meta"
        ).length;

        const failed = results.filter(
            item =>
                item.status ===
                "failed"
        ).length;

        return res.status(200).json({
            totalProcessed:
                results.length,

            acceptedByMeta:
                accepted,

            failed,
            skipped,

            note:
                "Accepted by Meta does not guarantee delivery.",

            results
        });
    }
);

// --------------------------------------------------
// IMPORT LEADS FROM CSV
// --------------------------------------------------

app.post(
    "/import-leads",
    requireAdmin,
    upload.single("file"),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                    error: "Please upload a CSV file."
                });
            }

            const rows = parse(req.file.buffer, {
                columns: header => header.map(
                    value => value.trim().toLowerCase()
                ),
                skip_empty_lines: true,
                trim: true,
                bom: true
            });

            if (rows.length > 100) {
                return res.status(400).json({
                    error: "Maximum 100 rows per upload."
                });
            }

            const seen = new Set();
            let imported = 0;
            let skipped = 0;

            for (const row of rows) {
                const phone = normalizePhone(row.phone);

                const consent = String(
                    row.consent || ""
                ).trim().toLowerCase();

                const optedIn = [
                    "yes", "true", "1"
                ].includes(consent);

                if (
                    !validPhone(phone) ||
                    !optedIn ||
                    seen.has(phone)
                ) {
                    skipped++;
                    continue;
                }

                seen.add(phone);

                // Never overwrite an existing customer record.
                const response = await axios.post(
                    `${supabaseTableUrl()}?on_conflict=phone`,
                    {
                        phone,
                        lead_source: "CSV",
                        whatsapp_opt_in: true,
                        consent_recorded_at:
                            new Date().toISOString(),
                        stop_followup: false,
                        lead_status: "NEW"
                    },
                    {
                        headers: supabaseHeaders({
                            Prefer:
                                "resolution=ignore-duplicates,return=representation"
                        }),
                        timeout: 10000
                    }
                );

                if (response.data?.length) {
                    imported++;
                } else {
                    skipped++;
                }
            }

            return res.json({
                imported,
                skipped,
                message: "Lead import completed."
            });

        } catch (error) {
            console.error(
                "Import error:",
                error.response?.data || error.message
            );

            return res.status(500).json({
                error: "Lead import failed."
            });
        }
    }
);

// --------------------------------------------------
// AUTOMATIC FOLLOW-UP CONFIGURATION
// --------------------------------------------------

// Keep automatic WhatsApp sending disabled during testing.

const ENABLE_AUTO_FOLLOWUP =
    process.env.ENABLE_AUTO_FOLLOWUP === "true";

// Maximum number of jobs registered per request.
const FOLLOWUP_BATCH_LIMIT = 10;


const FOLLOWUP_SCHEDULE = [
    {
        day: 1,
        afterHours: 24,
        template: "investngain_day1_followup"
    },
    {
        day: 3,
        afterHours: 72,
        template: "investngain_day3_followup"
    },
    {
        day: 7,
        afterHours: 168,
        template: "_investngain_day7_followup"
    }
];

// --------------------------------------------------
// CHECK PENDING FOLLOW-UPS
// --------------------------------------------------

async function getPendingFollowups() {
    const response = await axios.get(supabaseTableUrl(), {
        params: {
            select: [
                "id",
                "phone",
                "followup_started_at",
                "followup_day1_sent_at",
                "followup_day3_sent_at",
                "followup_day7_sent_at"
            ].join(","),
            whatsapp_opt_in: "eq.true",
            stop_followup: "eq.false",
            followup_started_at: "not.is.null",
            order: "followup_started_at.asc",
            limit: 100
        },
        headers: supabaseHeaders(),
        timeout: 10000
    });

    const now = Date.now();
    const pending = [];

    for (const lead of response.data || []) {
        const started = Date.parse(lead.followup_started_at);

        if (!Number.isFinite(started)) {
            continue;
        }

        for (const item of FOLLOWUP_SCHEDULE) {
            const column = `followup_day${item.day}_sent_at`;

            const dueAt =
                started + item.afterHours * 60 * 60 * 1000;

            if (!lead[column] && now >= dueAt) {
                pending.push({
                    id: lead.id,
                    phone: lead.phone,
                    day: item.day,
                    template: item.template,
                    dueAt: new Date(dueAt).toISOString()
                });

                break;
            }
        }
    }

    return pending;
}

// --------------------------------------------------
// REGISTER PENDING FOLLOW-UP JOBS
// This saves jobs in Supabase only.
// No WhatsApp messages are sent here.
// --------------------------------------------------

async function registerPendingFollowupJobs() {
    const pending = await getPendingFollowups();

    const jobs = pending
        .slice(0, FOLLOWUP_BATCH_LIMIT)
        .map(item => ({
            lead_id: item.id,
            followup_day: item.day,
            template_name: item.template,
            status: "pending"
        }));

    if (!jobs.length) {
        return {
            checked: pending.length,
            registered: 0,
            message: "No due follow-ups."
        };
    }

    const response = await axios.post(
        SUPABASE_URL.replace(/\/$/, "") +
            "/rest/v1/whatsapp_followup_jobs" +
            "?on_conflict=lead_id,followup_day",
        jobs,
        {
            headers: supabaseHeaders({
                Prefer:
                    "resolution=ignore-duplicates,return=representation"
            }),
            timeout: 10000
        }
    );

    return {
        checked: pending.length,
        registered: response.data?.length || 0,
        message:
            "Follow-up jobs registered. No messages sent."
    };
}

// --------------------------------------------------
// REGISTER FOLLOW-UP JOBS API
// Admin-protected POST endpoint.
// --------------------------------------------------

app.post(
    "/register-followup-jobs",
    requireAdmin,

    async (req, res) => {
        try {
            const result =
                await registerPendingFollowupJobs();

            return res.json(result);

        } catch (error) {
            console.error(
                "Job registration error:",
                error.response?.data || error.message
            );

            return res.status(500).json({
                error:
                    "Could not register follow-up jobs."
            });
        }
    }
);

// --------------------------------------------------
// PENDING FOLLOW-UP API
// Read-only endpoint.
// --------------------------------------------------

app.get(
    "/pending-followups",
    requireAdmin,

    async (req, res) => {
        try {
            const pending = await getPendingFollowups();

            return res.json({
                autoSendingEnabled: ENABLE_AUTO_FOLLOWUP,
                pendingCount: pending.length,
                pending
            });

        } catch (error) {
            console.error(
                "Pending follow-up error:",
                error.response?.data || error.message
            );

            return res.status(500).json({
                error:
                    "Could not check pending follow-ups."
            });
        }
    }
);

//
// SAFE FOLLOW-UP JOB PREVIEW
// Read-only: does not claim or send anything.
//

app.get(
    "/preview-followup-job/:id",
    requireAdmin,
    async (req, res) => {
        try {
            const jobId = Number(req.params.id);

            if (
                !Number.isSafeInteger(jobId) ||
                jobId < 1
            ) {
                return res.status(400).json({
                    error: "Invalid job ID."
                });
            }

            const url =
                SUPABASE_URL.replace(/\/$/, "") +
                "/rest/v1/whatsapp_followup_jobs";

            const response = await axios.get(url, {
                params: {
                    id: `eq.${jobId}`,
                    select: [
                        "id",
                        "lead_id",
                        "followup_day",
                        "template_name",
                        "status",
                        "attempt_count",
                        "claimed_at"
                    ].join(","),
                    limit: 1
                },
                headers: supabaseHeaders(),
                timeout: 10000
            });

            const job = response.data?.[0];

            if (!job) {
                return res.status(404).json({
                    error: "Job not found."
                });
            }

            const leadResponse = await axios.get(
                supabaseTableUrl(),
                {
                    params: {
                        id: `eq.${job.lead_id}`,
                        select:
                            "id,whatsapp_opt_in,stop_followup,last_reply_at",
                        limit: 1
                    },
                    headers: supabaseHeaders(),
                    timeout: 10000
                }
            );

            const lead = leadResponse.data?.[0];

            const expectedTemplates = {
                1: "investngain_day1_followup",
                3: "investngain_day3_followup",
                7: "_investngain_day7_followup"
            };

            const eligible = Boolean(
                lead &&
                job.status === "pending" &&
                lead.whatsapp_opt_in === true &&
                lead.stop_followup === false &&
                !lead.last_reply_at &&
                job.template_name ===
                    expectedTemplates[job.followup_day]
            );

            return res.json({
                jobId: job.id,
                followupDay: job.followup_day,
                template: job.template_name,
                status: job.status,
                attemptCount: job.attempt_count,
                eligibleForProcessing: eligible,
                messageSent: false,
                note: "Read-only preview. No job claimed or message sent."
            });

        } catch (error) {
            console.error(
                "Follow-up preview error:",
                error.response?.data || error.message
            );

            return res.status(500).json({
                error: "Could not preview follow-up job."
            });
        }
    }
);

//
// CONTROLLED FOLLOW-UP PROCESSING
// Safety lock: no message sending in this version.
//

app.post(
    "/process-followup-job/:id",
    requireAdmin,
    async (req, res) => {
        return res.status(403).json({
            jobId: req.params.id,
            processingEnabled: false,
            messageSent: false,
            message:
                "Safety lock active. Live processing is not enabled."
        });
    }
);


// --------------------------------------------------
// ERROR HANDLING
// --------------------------------------------------

app.use((error, req, res, next) => {
    if (
        error instanceof
        multer.MulterError
    ) {
        return res.status(400).json({
            error:
                "CSV upload failed. Maximum file size is 1 MB."
        });
    }

    if (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    next();
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
    console.log(
        `Invest N Gain Backend running on port ${PORT}`
    );
});
