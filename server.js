
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');

const app = express();

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN =
  process.env.VERIFY_TOKEN || 'investngain_webhook_2026';

const {
  WHATSAPP_ACCESS_TOKEN,
  PHONE_NUMBER_ID,
  ADMIN_API_KEY,
  META_APP_SECRET,
  SUPABASE_URL,
  SUPABASE_SECRET_KEY
} = process.env;

const ENABLE_BULK_SENDING =
  process.env.ENABLE_BULK_SENDING === 'true';

const ENABLE_AUTO_FOLLOWUP =
  process.env.ENABLE_AUTO_FOLLOWUP === 'true';

const TEMPLATE_LANGUAGE = 'en';
const TEMPLATE_NAME = 'property_update_investngain';

const MAX_RECIPIENTS = 100;
const FOLLOWUP_BATCH_LIMIT = 10;

const FOLLOWUP_SCHEDULE = [
  {
    day: 1,
    afterHours: 24,
    template: 'investngain_day1_followup'
  },
  {
    day: 3,
    afterHours: 72,
    template: 'investngain_day3_followup'
  },
  {
    day: 7,
    afterHours: 168,
    template: '_investngain_day7_followup'
  }
];

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const normalizePhone = value =>
  String(value || '').replace(/\D/g, '');

const validPhone = value =>
  /^\d{10,15}$/.test(value);

const now = () => new Date().toISOString();

const errorDetails = error =>
  error.response?.data || error.message;

const errorText = error =>
  String(
    error.response?.data?.error?.message ||
    error.response?.data?.message ||
    error.message
  ).slice(0, 1000);

// --------------------------------------------------
// EXPRESS CONFIGURATION
// --------------------------------------------------

app.use(
  express.json({
    limit: '1mb',

    verify(req, res, buffer) {
      req.rawBody = Buffer.from(buffer);
    }
  })
);

// --------------------------------------------------
// ADMIN SECURITY
// --------------------------------------------------

function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(503).json({
      error: 'ADMIN_API_KEY is not configured.'
    });
  }

  const supplied = req.get('x-admin-key');

  if (!supplied) {
    return res.status(401).json({
      error: 'Admin key required.'
    });
  }

  const expectedBuffer = Buffer.from(ADMIN_API_KEY);
  const suppliedBuffer = Buffer.from(supplied);

  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !crypto.timingSafeEqual(
      expectedBuffer,
      suppliedBuffer
    )
  ) {
    return res.status(401).json({
      error: 'Unauthorized.'
    });
  }

  next();
}

function requireWhatsAppConfig() {
  if (!PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    throw new Error(
      'WhatsApp credentials are missing in Render.'
    );
  }
}

function requireSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error(
      'Supabase environment variables are missing.'
    );
  }
}

// --------------------------------------------------
// SUPABASE
// --------------------------------------------------

function supabaseHeaders(extra = {}) {
  requireSupabaseConfig();

  return {
    apikey: SUPABASE_SECRET_KEY,

    Authorization:
      `Bearer ${SUPABASE_SECRET_KEY}`,

    'Content-Type': 'application/json',

    ...extra
  };
}

function dbUrl(path) {
  requireSupabaseConfig();

  return (
    SUPABASE_URL.replace(/\/$/, '') +
    '/rest/v1/' +
    path
  );
}

const leadsUrl = () => dbUrl('whatsapp_leads');

const jobsUrl = () =>
  dbUrl('whatsapp_followup_jobs');

async function rpc(name, data) {
  const response = await axios.post(
    dbUrl(`rpc/${name}`),
    data,
    {
      headers: supabaseHeaders(),
      timeout: 10000
    }
  );

  return response.data;
}

async function readOne(url, params) {
  const response = await axios.get(url, {
    params: {
      ...params,
      limit: 1
    },

    headers: supabaseHeaders(),
    timeout: 10000
  });

  return response.data?.[0] || null;
}

async function readLeadByPhone(phone) {
  return readOne(leadsUrl(), {
    phone: `eq.${phone}`,

    select: [
      'id',
      'phone',
      'lead_status',
      'stop_followup',
      'last_message_type',
      'last_reply_at',
      'whatsapp_opt_in'
    ].join(',')
  });
}

async function readLeadById(id) {
  return readOne(leadsUrl(), {
    id: `eq.${id}`,

    select: [
      'id',
      'phone',
      'whatsapp_opt_in',
      'stop_followup',
      'last_reply_at',
      'followup_started_at',
      'followup_day1_sent_at',
      'followup_day3_sent_at',
      'followup_day7_sent_at'
    ].join(',')
  });
}

async function readJob(id) {
  return readOne(jobsUrl(), {
    id: `eq.${id}`,
    select: '*'
  });
}

async function patchJob(id, payload, filters = {}) {
  return axios.patch(
    jobsUrl(),

    {
      ...payload,
      updated_at: now()
    },

    {
      params: {
        id: `eq.${id}`,
        ...filters
      },

      headers: supabaseHeaders({
        Prefer: 'return=representation'
      }),

      timeout: 10000
    }
  );
}

// --------------------------------------------------
// FOLLOW-UP ELIGIBILITY
// --------------------------------------------------

function eligibleLead(lead) {
  return Boolean(
    lead &&
    lead.whatsapp_opt_in === true &&
    lead.stop_followup === false &&
    !lead.last_reply_at &&
    validPhone(normalizePhone(lead.phone))
  );
}

function jobDue(job, lead) {
  const schedule = FOLLOWUP_SCHEDULE.find(
    item => item.day === job.followup_day
  );

  if (
    !schedule ||
    !lead?.followup_started_at ||
    job.template_name !== schedule.template
  ) {
    return false;
  }

  const started = Date.parse(
    lead.followup_started_at
  );

  if (!Number.isFinite(started)) {
    return false;
  }

  const dueAt =
    started + schedule.afterHours * 3600000;

  const sentColumn =
    `followup_day${schedule.day}_sent_at`;

  return (
    Date.now() >= dueAt &&
    !lead[sentColumn]
  );
}

// --------------------------------------------------
// CLASSIFY CUSTOMER REPLIES
// --------------------------------------------------

function classifyLead(message) {
  const text = String(
    message.text?.body ||
    message.button?.text ||
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.title ||
    ''
  )
    .trim()
    .toLowerCase();

  if (
    /\b(not interested|no thanks|stop|unsubscribe)\b/
      .test(text)
  ) {
    return 'NOT_INTERESTED';
  }

  if (
    /\b(call back|callback|call me|later|tomorrow)\b/
      .test(text)
  ) {
    return 'CALL_BACK';
  }

  if (
    /\b(interested|yes|details|price|site visit)\b/
      .test(text)
  ) {
    return 'INTERESTED';
  }

  return 'NEEDS_REVIEW';
}

// --------------------------------------------------
// META WEBHOOK SIGNATURE SECURITY
// --------------------------------------------------

function verifyMetaSignature(req, res, next) {
  if (!META_APP_SECRET) {
    return res.sendStatus(503);
  }

  const signature =
    req.get('x-hub-signature-256');

  if (
    !signature ||
    !/^sha256=[a-f0-9]{64}$/i.test(signature) ||
    !req.rawBody
  ) {
    return res.sendStatus(403);
  }

  const expected =
    'sha256=' +
    crypto
      .createHmac('sha256', META_APP_SECRET)
      .update(req.rawBody)
      .digest('hex');

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
    return res.sendStatus(403);
  }

  next();
}

// --------------------------------------------------
// CSV UPLOAD
// --------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 1024 * 1024,
    files: 1
  },

  fileFilter(req, file, cb) {
    const valid =
      file.mimetype === 'text/csv' ||
      file.originalname.toLowerCase().endsWith('.csv');

    if (!valid) {
      return cb(
        new Error('Please upload a CSV file.')
      );
    }

    cb(null, true);
  }
});

// --------------------------------------------------
// WHATSAPP TEMPLATE HELPER
// --------------------------------------------------

async function sendTemplate(
  recipient,
  templateName = TEMPLATE_NAME,
  customerName = 'Customer'
) {
  requireWhatsAppConfig();

  const allowedTemplates = [
    'investngain_day1_followup',
    'investngain_day3_followup',
    '_investngain_day7_followup',
    'hello_world',
    'property_update_investngain',
    'lead_followup_test',
    'new_utility_temp',
    'utility_by_harsh',
    'by_harsh_2'
  ];

  if (!allowedTemplates.includes(templateName)) {
    throw new Error('Template is not allowed.');
  }

  const template = {
    name: templateName,

    language: {
      code: TEMPLATE_LANGUAGE
    }
  };

  if (templateName === 'by_harsh_2') {
    template.components = [
      {
        type: 'body',

        parameters: [
          {
            type: 'text',
            text: String(customerName || 'Customer')
          }
        ]
      }
    ];
  }

  return axios.post(
    `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`,

    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'template',
      template
    },

    {
      headers: {
        Authorization:
          `Bearer ${WHATSAPP_ACCESS_TOKEN}`,

        'Content-Type': 'application/json'
      },

      timeout: 20000
    }
  );
}

// --------------------------------------------------
// HOME
// --------------------------------------------------

app.get('/', (req, res) => {
  res.send(
    'Invest N Gain WhatsApp Backend is running!'
  );
});

// --------------------------------------------------
// META WEBHOOK VERIFICATION
// --------------------------------------------------

app.get('/webhook', (req, res) => {
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === VERIFY_TOKEN &&
    req.query['hub.challenge']
  ) {
    return res
      .status(200)
      .send(req.query['hub.challenge']);
  }

  return res.sendStatus(403);
});

// --------------------------------------------------
// CUSTOMER REPLIES + DELIVERY TRACKING
// --------------------------------------------------

app.post(
  '/webhook',
  verifyMetaSignature,

  async (req, res) => {
    try {
      for (const entry of req.body?.entry || []) {
        for (const change of entry.changes || []) {

          // CUSTOMER REPLIES

          for (
            const message of
            change.value?.messages || []
          ) {
            const phone = normalizePhone(
              message.from
            );

            if (!validPhone(phone)) {
              continue;
            }

            await axios.post(
              `${leadsUrl()}?on_conflict=phone`,

              {
                phone,
                lead_status: classifyLead(message),
                stop_followup: true,
                last_message_type: message.type,
                last_reply_at: now(),
                updated_at: now()
              },

              {
                headers: supabaseHeaders({
                  Prefer: 'resolution=merge-duplicates'
                }),

                timeout: 10000
              }
            );

            console.log(
              'Customer reply recorded. Pending follow-ups are handled by database trigger.'
            );
          }

          // META MESSAGE STATUS UPDATES

          for (
            const status of
            change.value?.statuses || []
          ) {
            const messageId = status.id;

            const allowedStatuses = [
              'sent',
              'delivered',
              'read',
              'failed'
            ];

            if (
              !messageId ||
              !allowedStatuses.includes(status.status)
            ) {
              continue;
            }

            const matching = await readOne(
              jobsUrl(),

              {
                meta_message_id:
                  `eq.${messageId}`,

                select:
                  'id,status,meta_delivery_status'
              }
            );

            if (!matching) {
              continue;
            }

            const rank = {
              accepted: 0,
              sent: 1,
              delivered: 2,
              read: 3,
              failed: 1
            };

            const previous =
              matching.meta_delivery_status ||
              'accepted';

            if (
              (rank[status.status] || 0) <
              (rank[previous] || 0)
            ) {
              continue;
            }

            if (
              previous === 'failed' &&
              status.status !== 'failed'
            ) {
              continue;
            }

            if (
              status.status === 'failed' &&
              ['delivered', 'read'].includes(previous)
            ) {
              continue;
            }

            const payload = {
              meta_delivery_status: status.status,
              meta_status_updated_at: now()
            };

            if (
              status.status === 'delivered' ||
              status.status === 'read'
            ) {
              payload.status = 'delivered';
            }

            if (status.status === 'failed') {
              payload.status = 'needs_review';

              payload.last_error = JSON.stringify(
                status.errors || []
              ).slice(0, 1000);
            }

            await patchJob(
              matching.id,
              payload,

              {
                meta_message_id:
                  `eq.${messageId}`
              }
            );

            console.log(
              'Follow-up delivery event recorded:',
              matching.id,
              status.status
            );
          }
        }
      }

      return res.sendStatus(200);

    } catch (error) {
      console.error(
        'Webhook processing error:',
        errorDetails(error)
      );

      return res.sendStatus(500);
    }
  }
);

// --------------------------------------------------
// FOLLOW-UP STATUS
// --------------------------------------------------

app.get(
  '/followup-status',
  requireAdmin,

  async (req, res) => {
    try {
      const phone = normalizePhone(
        req.query.recipient
      );

      if (!validPhone(phone)) {
        return res.status(400).json({
          error: 'Provide a valid recipient number.'
        });
      }

      const lead = await readLeadByPhone(phone);

      return res.json({
        recipient: phone,

        stopFollowUp: Boolean(
          lead?.stop_followup
        ),

        details: lead
          ? {
              stopped: lead.stop_followup,
              repliedAt: lead.last_reply_at,
              messageType: lead.last_message_type,
              leadStatus: lead.lead_status
            }
          : null
      });

    } catch (error) {
      console.error(errorDetails(error));

      return res.status(500).json({
        error: 'Could not retrieve lead status.'
      });
    }
  }
);

// --------------------------------------------------
// MANUAL NORMAL MESSAGE
// --------------------------------------------------

app.post(
  '/send-message',
  requireAdmin,

  async (req, res) => {
    try {
      const recipient = normalizePhone(
        req.body?.recipient
      );

      const message = String(
        req.body?.message || ''
      ).trim();

      if (!validPhone(recipient) || !message) {
        return res.status(400).json({
          error:
            'Valid recipient and message are required.'
        });
      }

      requireWhatsAppConfig();

      const response = await axios.post(
        `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`,

        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: 'text',

          text: {
            body: message
          }
        },

        {
          headers: {
            Authorization:
              `Bearer ${WHATSAPP_ACCESS_TOKEN}`,

            'Content-Type': 'application/json'
          },

          timeout: 20000
        }
      );

      return res.json(response.data);

    } catch (error) {
      console.error(
        'Send message:',
        errorDetails(error)
      );

      return res.status(500).json({
        error: errorDetails(error)
      });
    }
  }
);

// --------------------------------------------------
// MANUAL TEMPLATE MESSAGE
// --------------------------------------------------

app.post(
  '/send-template',
  requireAdmin,

  async (req, res) => {
    try {
      const phone = normalizePhone(
        req.body?.recipient
      );

      if (!validPhone(phone)) {
        return res.status(400).json({
          error: 'Valid recipient number required.'
        });
      }

      const lead = await readLeadByPhone(phone);

      if (lead?.stop_followup) {
        return res.status(409).json({
          error: 'Customer has already replied.',
          leadStatus: lead.lead_status
        });
      }

      const response = await sendTemplate(phone);

      return res.json(response.data);

    } catch (error) {
      console.error(
        'Send template:',
        errorDetails(error)
      );

      return res.status(500).json({
        error: errorDetails(error)
      });
    }
  }
);

// --------------------------------------------------
// BULK TEMPLATE SENDING
// DISABLED UNLESS EXPLICITLY ENABLED
// --------------------------------------------------

app.post(
  '/bulk-template',
  requireAdmin,
  upload.single('file'),

  async (req, res) => {
    if (!ENABLE_BULK_SENDING) {
      return res.status(403).json({
        error: 'Bulk sending is disabled in Render.'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Upload CSV in the 'file' field."
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
        error: 'Invalid CSV format.'
      });
    }

    if (!rows.length) {
      return res.status(400).json({
        error: 'CSV has no customer rows.'
      });
    }

    const headers = Object.keys(rows[0]).map(
      header => header.trim().toLowerCase()
    );

    if (
      !headers.includes('phone') ||
      !headers.includes('consent')
    ) {
      return res.status(400).json({
        error:
          'CSV must contain phone and consent columns.'
      });
    }

    const seen = new Set();
    const recipients = [];

    let skipped = 0;

    for (const row of rows) {
      const normalizedRow = Object.fromEntries(
        Object.entries(row).map(
          ([key, value]) => [
            key.trim().toLowerCase(),
            value
          ]
        )
      );

      const phone = normalizePhone(
        normalizedRow.phone
      );

      const optedIn = [
        'yes',
        'true',
        '1'
      ].includes(
        String(
          normalizedRow.consent || ''
        ).trim().toLowerCase()
      );

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

    if (recipients.length > MAX_RECIPIENTS) {
      return res.status(400).json({
        error:
          `Maximum ${MAX_RECIPIENTS} recipients allowed.`,

        eligible: recipients.length,
        skipped
      });
    }

    if (!recipients.length) {
      return res.status(400).json({
        error: 'No valid opted-in recipients.',
        skipped
      });
    }

    const results = [];

    try {
      requireWhatsAppConfig();
      requireSupabaseConfig();

    } catch (error) {
      return res.status(503).json({
        error: error.message
      });
    }

    for (const phone of recipients) {
      try {
        const lead = await readLeadByPhone(phone);

        if (!lead || !eligibleLead(lead)) {
          results.push({
            recipient: phone,
            status: 'skipped',

            reason:
              'Lead missing, no opt-in, or already replied'
          });

          skipped++;
          continue;
        }

        const response = await sendTemplate(phone);

        results.push({
          recipient: phone,
          status: 'accepted',

          messageId:
            response.data?.messages?.[0]?.id ||
            null
        });

      } catch (error) {
        results.push({
          recipient: phone,
          status: 'failed',
          error: errorText(error)
        });
      }

      await sleep(1000);
    }

    return res.json({
      totalProcessed: results.length,

      acceptedByMeta: results.filter(
        item => item.status === 'accepted'
      ).length,

      failed: results.filter(
        item => item.status === 'failed'
      ).length,

      skipped,

      note:
        'Meta acceptance does not guarantee delivery.',

      results
    });
  }
);

// --------------------------------------------------
// IMPORT LEADS FROM CSV
// --------------------------------------------------

app.post(
  '/import-leads',
  requireAdmin,
  upload.single('file'),

  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'Please upload a CSV file.'
        });
      }

      const rows = parse(req.file.buffer, {
        columns: headers =>
          headers.map(
            value => value.trim().toLowerCase()
          ),

        skip_empty_lines: true,
        trim: true,
        bom: true
      });

      if (rows.length > 100) {
        return res.status(400).json({
          error: 'Maximum 100 rows per upload.'
        });
      }

      const seen = new Set();

      let imported = 0;
      let skipped = 0;

      for (const row of rows) {
        const phone = normalizePhone(row.phone);

        const optedIn = [
          'yes',
          'true',
          '1'
        ].includes(
          String(row.consent || '')
            .trim()
            .toLowerCase()
        );

        if (
          !validPhone(phone) ||
          !optedIn ||
          seen.has(phone)
        ) {
          skipped++;
          continue;
        }

        seen.add(phone);

        const response = await axios.post(
          `${leadsUrl()}?on_conflict=phone`,

          {
            phone,
            lead_source: 'CSV',
            whatsapp_opt_in: true,
            consent_recorded_at: now(),
            stop_followup: false,
            lead_status: 'NEW'
          },

          {
            headers: supabaseHeaders({
              Prefer:
                'resolution=ignore-duplicates,return=representation'
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
        message: 'Lead import completed.'
      });

    } catch (error) {
      console.error(
        'Import error:',
        errorDetails(error)
      );

      return res.status(500).json({
        error: 'Lead import failed.'
      });
    }
  }
);

// --------------------------------------------------
// FIND DUE FOLLOW-UPS
// READ ONLY
// --------------------------------------------------

async function getPendingFollowups() {
  const response = await axios.get(
    leadsUrl(),

    {
      params: {
        select: [
          'id',
          'phone',
          'followup_started_at',
          'followup_day1_sent_at',
          'followup_day3_sent_at',
          'followup_day7_sent_at',
          'last_reply_at'
        ].join(','),

        whatsapp_opt_in: 'eq.true',
        stop_followup: 'eq.false',
        last_reply_at: 'is.null',

        followup_started_at: 'not.is.null',

        order: 'followup_started_at.asc',
        limit: 100
      },

      headers: supabaseHeaders(),
      timeout: 10000
    }
  );

  const pending = [];

  for (const lead of response.data || []) {
    const started = Date.parse(
      lead.followup_started_at
    );

    if (!Number.isFinite(started)) {
      continue;
    }

    for (const item of FOLLOWUP_SCHEDULE) {
      const dueAt =
        started + item.afterHours * 3600000;

      const sentColumn =
        `followup_day${item.day}_sent_at`;

      if (
        !lead[sentColumn] &&
        Date.now() >= dueAt
      ) {
        pending.push({
          id: lead.id,
          phone: lead.phone,
          day: item.day,
          template: item.template,

          dueAt:
            new Date(dueAt).toISOString()
        });

        break;
      }
    }
  }

  return pending;
}

// --------------------------------------------------
// REGISTER FOLLOW-UP JOBS
// REGISTRATION ONLY — NO MESSAGE SENT
// --------------------------------------------------

async function registerPendingFollowupJobs() {
  const pending = await getPendingFollowups();

  const jobs = pending
    .slice(0, FOLLOWUP_BATCH_LIMIT)
    .map(item => ({
      lead_id: item.id,
      followup_day: item.day,
      template_name: item.template,
      status: 'pending'
    }));

  if (!jobs.length) {
    return {
      checked: pending.length,
      registered: 0,
      message: 'No due follow-ups.'
    };
  }

  const response = await axios.post(
    `${jobsUrl()}?on_conflict=lead_id,followup_day`,

    jobs,

    {
      headers: supabaseHeaders({
        Prefer:
          'resolution=ignore-duplicates,return=representation'
      }),

      timeout: 10000
    }
  );

  return {
    checked: pending.length,

    registered:
      response.data?.length || 0,

    message:
      'Follow-up jobs registered. No messages sent.'
  };
}

// --------------------------------------------------
// PENDING FOLLOW-UPS API
// --------------------------------------------------

app.get(
  '/pending-followups',
  requireAdmin,

  async (req, res) => {
    try {
      const pending =
        await getPendingFollowups();

      return res.json({
        autoSendingEnabled:
          ENABLE_AUTO_FOLLOWUP,

        pendingCount: pending.length,
        pending
      });

    } catch (error) {
      console.error(errorDetails(error));

      return res.status(500).json({
        error: 'Could not check pending follow-ups.'
      });
    }
  }
);

// --------------------------------------------------
// REGISTER JOBS API
// --------------------------------------------------

app.post(
  '/register-followup-jobs',
  requireAdmin,

  async (req, res) => {
    try {
      const result =
        await registerPendingFollowupJobs();

      return res.json(result);

    } catch (error) {
      console.error(errorDetails(error));

      return res.status(500).json({
        error:
          'Could not register follow-up jobs.'
      });
    }
  }
);

// --------------------------------------------------
// PREVIEW JOB
// NO CLAIM / NO SEND
// --------------------------------------------------

app.get(
  '/preview-followup-job/:id',
  requireAdmin,

  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (
        !Number.isSafeInteger(id) ||
        id < 1
      ) {
        return res.status(400).json({
          error: 'Invalid job ID.'
        });
      }

      const job = await readJob(id);

      if (!job) {
        return res.status(404).json({
          error: 'Job not found.'
        });
      }

      const lead = await readLeadById(
        job.lead_id
      );

      const eligible = Boolean(
        id !== 1 &&
        job.status === 'pending' &&
        job.attempt_count === 0 &&
        !job.send_started_at &&
        !job.meta_message_id &&
        eligibleLead(lead) &&
        jobDue(job, lead)
      );

      return res.json({
        jobId: id,
        followupDay: job.followup_day,
        template: job.template_name,
        status: job.status,
        attemptCount: job.attempt_count,

        eligibleForProcessing: eligible,
        messageSent: false,

        note:
          'Read-only preview. Job ID 1 is permanently excluded from further sending.'
      });

    } catch (error) {
      console.error(errorDetails(error));

      return res.status(500).json({
        error: 'Could not preview follow-up job.'
      });
    }
  }
);

// --------------------------------------------------
// RETIRE OLD TEST ENDPOINTS
// JOB ID 1 MUST NEVER BE RESENT
// --------------------------------------------------

app.post(
  '/process-followup-job/:id',
  requireAdmin,

  (req, res) => {
    return res.status(410).json({
      error:
        'Legacy test-claim endpoint retired. No action taken.'
    });
  }
);

app.post(
  '/send-followup-job/:id',
  requireAdmin,

  (req, res) => {
    return res.status(410).json({
      error:
        'Legacy test-send endpoint retired. Job ID 1 must never be resent.'
    });
  }
);

// --------------------------------------------------
// CONTROLLED FOLLOW-UP SEND
// TEST RECIPIENT ONLY
// NO SCHEDULER / NO AUTOMATIC RETRY
// --------------------------------------------------

app.post(
  '/send-controlled-followup/:id',
  requireAdmin,

  async (req, res) => {
    const id = Number(req.params.id);

    if (
      !Number.isSafeInteger(id) ||
      id <= 1
    ) {
      return res.status(403).json({
        error:
          'Job ID 1 is permanently protected. Provide a different valid ID.'
      });
    }

    if (ENABLE_AUTO_FOLLOWUP) {
      return res.status(403).json({
        error:
          'Disable automatic follow-up before controlled testing.'
      });
    }

    const confirmation =
      `SEND_FOLLOWUP_JOB_${id}`;

    if (
      req.body?.confirmSend !== confirmation
    ) {
      return res.status(400).json({
        error:
          `Explicit confirmation ${confirmation} required.`
      });
    }

    const testRecipient = normalizePhone(
      process.env.TEST_FOLLOWUP_RECIPIENT
    );

    if (!validPhone(testRecipient)) {
      return res.status(503).json({
        error:
          'TEST_FOLLOWUP_RECIPIENT is missing or invalid.'
      });
    }

    let sendStarted = false;
    let acceptedMessageId = null;

    try {
      requireWhatsAppConfig();
      requireSupabaseConfig();

      const job = await readJob(id);

      const lead = job
        ? await readLeadById(job.lead_id)
        : null;

      if (
        !job ||
        job.status !== 'pending' ||
        job.attempt_count !== 0 ||
        job.send_started_at ||
        job.meta_message_id ||
        !eligibleLead(lead) ||
        !jobDue(job, lead) ||
        normalizePhone(lead.phone) !== testRecipient
      ) {
        return res.status(409).json({
          error:
            'Job is not eligible, not due, already attempted, or recipient is not the test number.',

          messageSent: false
        });
      }

      // Atomic database claim.

      const claimed = await rpc(
        'claim_whatsapp_followup_job',

        {
          p_job_id: id
        }
      );

      if (
        !Array.isArray(claimed) ||
        claimed.length !== 1
      ) {
        return res.status(409).json({
          error:
            'Atomic claim unavailable. No Meta request made.',

          messageSent: false
        });
      }

      // Atomic sending lock.

      const locked = await rpc(
        'begin_whatsapp_followup_send',

        {
          p_job_id: id
        }
      );

      if (
        !Array.isArray(locked) ||
        locked.length !== 1
      ) {
        return res.status(409).json({
          error:
            'Sending lock unavailable. Inspect claimed job; do not retry blindly.',

          messageSent: false
        });
      }

      sendStarted = true;

      // Final eligibility check.

      const finalLead = await readLeadById(
        job.lead_id
      );

      if (
        !eligibleLead(finalLead) ||
        !jobDue(job, finalLead) ||
        normalizePhone(finalLead.phone) !==
          testRecipient
      ) {
        await patchJob(
          id,

          {
            status: 'needs_review',

            last_error:
              'Final consent/due check failed after sending lock.'
          },

          {
            status: 'eq.processing',
            meta_message_id: 'is.null'
          }
        );

        return res.status(409).json({
          error:
            'Final eligibility check failed.',

          messageSent: false,
          retryAllowed: false
        });
      }

      // Only Meta sending call in this endpoint.

      const meta = await sendTemplate(
        testRecipient,
        job.template_name
      );

      acceptedMessageId =
        meta.data?.messages?.[0]?.id ||
        null;

      if (!acceptedMessageId) {
        throw new Error(
          'Meta response did not contain a message ID.'
        );
      }

      // Complete database transaction.
      // SQL function now uses status = accepted.

      const completed = await rpc(
        'complete_whatsapp_followup_send',

        {
          p_job_id: id,
          p_meta_message_id: acceptedMessageId
        }
      );

      if (
        !Array.isArray(completed) ||
        completed.length !== 1
      ) {
        throw new Error(
          'Meta accepted the message but database completion was not confirmed.'
        );
      }

      return res.json({
        jobId: id,
        status: 'accepted',
        metaMessageId: acceptedMessageId,
        acceptedByMeta: true,
        retryAllowed: false,

        note:
          'Meta acceptance does not guarantee delivery.'
      });

    } catch (error) {
      console.error(
        'Controlled follow-up error:',
        errorDetails(error),

        acceptedMessageId
          ? { acceptedMessageId }
          : ''
      );

      if (sendStarted) {
        try {
          const lastError = acceptedMessageId
            ? (
                `Meta accepted: ${acceptedMessageId}; ` +
                `database completion uncertain: ${errorText(error)}`
              )
            : errorText(error);

          await patchJob(
            id,

            {
              status: 'needs_review',
              last_error: lastError.slice(0, 1000)
            },

            {
              status: 'eq.processing',
              meta_message_id: 'is.null'
            }
          );

        } catch (databaseError) {
          console.error(
            'Could not record uncertain send:',
            errorDetails(databaseError)
          );
        }
      }

      return res.status(500).json({
        error:
          'Sending or completion could not be confirmed.',

        acceptedByMeta:
          Boolean(acceptedMessageId),

        metaMessageId: acceptedMessageId,

        retryAllowed: false,

        note:
          'Inspect Meta and Supabase. Never resend automatically.'
      });
    }
  }
);

// --------------------------------------------------
// JOB STATUS
// READ ONLY
// --------------------------------------------------

app.get(
  '/followup-job-status/:id',
  requireAdmin,

  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (
        !Number.isSafeInteger(id) ||
        id < 1
      ) {
        return res.status(400).json({
          error: 'Invalid job ID.'
        });
      }

      const job = await readJob(id);

      if (!job) {
        return res.status(404).json({
          error: 'Job not found.'
        });
      }

      return res.json({
        id: job.id,
        status: job.status,
        attemptCount: job.attempt_count,

        metaMessageId:
          job.meta_message_id,

        metaDeliveryStatus:
          job.meta_delivery_status,

        metaAcceptedAt:
          job.meta_accepted_at,

        sendStartedAt:
          job.send_started_at,

        lastError:
          job.last_error,

        retryAllowed: false
      });

    } catch (error) {
      console.error(errorDetails(error));

      return res.status(500).json({
        error: 'Could not retrieve job.'
      });
    }
  }
);

// --------------------------------------------------
// ERROR HANDLING
// --------------------------------------------------

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error:
        'CSV upload failed. Maximum file size is 1 MB.'
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
