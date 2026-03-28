const path = require("path");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT || 3000);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.length === 0) {
        console.warn(
          "ALLOWED_ORIGINS is empty — CORS allows any origin. Set ALLOWED_ORIGINS in production (e.g. your GitHub Pages URL)."
        );
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

/** When true, contact submissions are inserted into PostgreSQL. Default: off (email only). */
const contactStoreInDb =
  process.env.CONTACT_STORE_IN_DB === "true" ||
  process.env.CONTACT_STORE_IN_DB === "1";

const requiredSmtpEnv = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "CONTACT_TO_EMAIL",
];

const missingSmtp = requiredSmtpEnv.filter((key) => !process.env[key]);
if (missingSmtp.length > 0) {
  console.warn(
    "Missing SMTP environment variables:",
    missingSmtp.join(", "),
    "- the contact API cannot send email until these are set."
  );
}

if (contactStoreInDb && !process.env.DATABASE_URL) {
  console.warn(
    "CONTACT_STORE_IN_DB is enabled but DATABASE_URL is missing — contact saves will fail."
  );
}

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.PG_SSL === "true"
        ? {
            rejectUnauthorized: false,
          }
        : false,
  });
} else if (contactStoreInDb) {
  console.warn(
    "DATABASE_URL is not set — enable CONTACT_STORE_IN_DB only after configuring PostgreSQL."
  );
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 900000);
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 10);
const rateBuckets = new Map();

function pruneRateBuckets(now) {
  if (rateBuckets.size < 5000) {
    return;
  }
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) {
      rateBuckets.delete(key);
    }
  }
}

function contactRateLimiter(req, res, next) {
  const now = Date.now();
  pruneRateBuckets(now);
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + rateLimitWindowMs };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > rateLimitMax) {
    return res.status(429).json({
      ok: false,
      message: "Too many requests. Please try again later.",
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    return res.status(503).json({
      ok: false,
      message: "Admin API is not configured (set ADMIN_API_TOKEN).",
    });
  }
  const header = req.headers.authorization || "";
  const expected = `Bearer ${token}`;
  if (header !== expected) {
    return res.status(401).json({ ok: false, message: "Unauthorized." });
  }
  next();
}

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

function sanitizeText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, maxLength);
}

function honeypotTriggered(payload) {
  const trap = sanitizeText(payload.contact_trap || payload.website || "", 200);
  return trap.length > 0;
}

function validatePayload(payload) {
  const name = sanitizeText(payload.name, 120);
  const email = sanitizeText(payload.email, 255).toLowerCase();
  const company = sanitizeText(payload.company, 255);
  const interest = sanitizeText(payload.interest, 120);
  const message = sanitizeText(payload.message, 4000);

  if (!name || !email || !interest || !message) {
    return { error: "Please fill out all required fields." };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { error: "Please enter a valid email address." };
  }

  return {
    data: {
      name,
      email,
      company,
      interest,
      message,
    },
  };
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/admin/submissions", requireAdmin, async (req, res) => {
  if (!pool) {
    return res.status(503).json({
      ok: false,
      message: "Database not configured (set DATABASE_URL).",
    });
  }

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const countResult = await pool.query(
      "SELECT COUNT(*)::bigint AS total FROM contact_submissions"
    );
    const total = Number(countResult.rows[0].total);

    const rowsResult = await pool.query(
      `SELECT id, name, email, company, interest, message, created_at
       FROM contact_submissions
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return res.status(200).json({
      ok: true,
      total,
      limit,
      offset,
      submissions: rowsResult.rows,
    });
  } catch (err) {
    console.error("Admin submissions error:", err);
    return res.status(500).json({
      ok: false,
      message: "Unable to load submissions.",
    });
  }
});

app.post("/api/contact", contactRateLimiter, async (req, res) => {
  if (honeypotTriggered(req.body || {})) {
    return res.status(400).json({ ok: false, message: "Invalid submission." });
  }

  const { data, error } = validatePayload(req.body || {});
  if (error) {
    return res.status(400).json({ ok: false, message: error });
  }

  try {
    let submissionId = null;
    let submittedAt = new Date().toISOString();

    if (contactStoreInDb) {
      if (!pool) {
        return res.status(503).json({
          ok: false,
          message:
            "Database storage is enabled but DATABASE_URL is not configured.",
        });
      }

      const insertQuery = `
      INSERT INTO contact_submissions (name, email, company, interest, message)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, created_at
    `;

      const insertValues = [
        data.name,
        data.email,
        data.company || null,
        data.interest,
        data.message,
      ];

      const dbResult = await pool.query(insertQuery, insertValues);
      const row = dbResult.rows[0];
      submissionId = row.id;
      submittedAt = row.created_at;
    }

    const mailSubject = `New inquiry - TechCapital Solutions`;
    const mailText = [
      "A new contact form submission was received.",
      "",
      contactStoreInDb
        ? `Submission ID: ${submissionId}`
        : "Submission ID: (not stored — CONTACT_STORE_IN_DB is disabled)",
      `Submitted At: ${submittedAt}`,
      `Name: ${data.name}`,
      `Email: ${data.email}`,
      `Company: ${data.company || "(not provided)"}`,
      `Interest: ${data.interest}`,
      "",
      "Message:",
      data.message,
    ].join("\n");

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: process.env.CONTACT_TO_EMAIL,
      replyTo: data.email,
      subject: mailSubject,
      text: mailText,
    });

    return res.status(200).json({
      ok: true,
      id: submissionId,
      stored: contactStoreInDb,
    });
  } catch (err) {
    console.error("Contact submission error:", err);
    return res.status(500).json({
      ok: false,
      message: "Unable to process your message right now.",
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(
    contactStoreInDb
      ? "Contact: PostgreSQL storage + email enabled (CONTACT_STORE_IN_DB)"
      : "Contact: email only — set CONTACT_STORE_IN_DB=true to persist submissions"
  );
});
