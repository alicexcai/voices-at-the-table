import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";
import { pool } from "./db.js";
import { handleNeonAuthWebhook, readRequestBody } from "./neon-auth-webhook.js";

const root = fileURLToPath(new URL(".", import.meta.url)).replace(/[\\/]+$/, "");
const port = Number(process.env.PORT || 3000);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 8 * 1024 * 1024) {
  const body = await readRequestBody(req, maxBytes);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON.");
  }
}

async function getAuthenticatedUser(req) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  return session?.user || null;
}

async function handleSetPassword(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, JSON.stringify({ error: "Method not allowed." }));
    return;
  }
  const user = await getAuthenticatedUser(req);
  if (!user) {
    sendJson(res, 401, JSON.stringify({ error: "Sign in before setting a password." }));
    return;
  }
  const body = await readJsonBody(req, 32 * 1024);
  if (!isString(body?.newPassword, 128) || body.newPassword.length < 8) {
    sendJson(res, 400, JSON.stringify({ error: "Use a password between 8 and 128 characters." }));
    return;
  }
  await auth.api.setPassword({
    body: { newPassword: body.newPassword },
    headers: fromNodeHeaders(req.headers)
  });
  sendJson(res, 200, JSON.stringify({ ok: true }));
}

function isString(value, maxLength = 10000) {
  return typeof value === "string" && value.length <= maxLength;
}

function isBoolean(value) {
  return typeof value === "boolean";
}

function validateSubmission(body) {
  if (!body || !isString(body.industry, 100) || !isString(body.role, 100) || !isString(body.occupation, 200) || !isString(body.city, 200)) {
    throw new Error("Some required response fields are missing.");
  }
  if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers) || Object.keys(body.answers).length < 1 || Object.keys(body.answers).length > 3) {
    throw new Error("The survey answers are invalid.");
  }
  for (const answer of Object.values(body.answers)) {
    if (!answer || typeof answer !== "object" || Array.isArray(answer) || !isString(answer.choice, 500) || !answer.choice.trim()) {
      throw new Error("Each prompt needs a starting point.");
    }
    if (answer.text !== undefined && answer.text !== null && !isString(answer.text, 10000)) throw new Error("A text response is invalid.");
    if (answer.audioData !== undefined && answer.audioData !== null && !isString(answer.audioData, 8 * 1024 * 1024)) throw new Error("A recording is too large.");
    if (answer.audioMimeType !== undefined && answer.audioMimeType !== null && !isString(answer.audioMimeType, 100)) throw new Error("A recording type is invalid.");
    if (answer.durationSeconds !== undefined && answer.durationSeconds !== null && (!Number.isInteger(answer.durationSeconds) || answer.durationSeconds < 0 || answer.durationSeconds > 60)) throw new Error("A recording duration is invalid.");
    if (!answer.text?.trim() && !answer.audioData) throw new Error("Each prompt needs a voice note or written response.");
  }
  if (!["isAnonymous", "roundtableInterest", "publishToWall", "useVoiceInRoundtable", "contactMe"].every((key) => isBoolean(body[key]))) {
    throw new Error("The consent choices are invalid.");
  }
  if (body.displayName !== null && !isString(body.displayName, 200)) throw new Error("The display name is invalid.");
}

async function handleSubmission(req, res) {
  const user = await getAuthenticatedUser(req);
  if (!user || (!user.phoneNumberVerified && !user.phone_number_verified && !user.emailVerified && !user.email_verified)) {
    sendJson(res, 401, JSON.stringify({ error: "Sign in with your verified account before submitting." }));
    return;
  }
  if (req.method === "GET") {
    const result = await pool.query(
      `SELECT id AS submission_id, industry, role, occupation, city, display_name,
              is_anonymous, answers, roundtable_interest, publish_to_wall,
              use_voice_in_roundtable, contact_me
       FROM public.submissions
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [user.id]
    );
    sendJson(res, 200, JSON.stringify(result.rows[0] || null));
    return;
  }
  if (req.method !== "POST" && req.method !== "PUT") {
    sendJson(res, 405, JSON.stringify({ error: "Method not allowed." }));
    return;
  }
  const body = await readJsonBody(req);
  validateSubmission(body);
  const answerSummary = Object.fromEntries(Object.entries(body.answers).map(([id, answer]) => [id, {
    choice: answer.choice.trim(),
    text: answer.text?.trim() || ""
  }]));
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    let submissionId;
    if (req.method === "PUT") {
      submissionId = Number(body.submissionId);
      if (!Number.isInteger(submissionId) || submissionId < 1) throw new Error("The submission could not be found.");
      const updated = await db.query(
        `UPDATE public.submissions
         SET industry = $1, role = $2, occupation = $3, city = $4, display_name = $5,
             is_anonymous = $6, answers = $7, roundtable_interest = $8,
             publish_to_wall = $9, use_voice_in_roundtable = $10, contact_me = $11
         WHERE id = $12 AND user_id = $13
         RETURNING id`,
        [
          body.industry,
          body.role,
          body.occupation,
          body.city,
          body.isAnonymous ? null : body.displayName?.trim() || null,
          body.isAnonymous,
          answerSummary,
          body.roundtableInterest,
          body.publishToWall,
          body.useVoiceInRoundtable,
          body.contactMe,
          submissionId,
          user.id
        ]
      );
      if (!updated.rowCount) throw new Error("The submission could not be found.");
      await db.query("DELETE FROM public.voice_notes WHERE submission_id = $1 AND user_id = $2", [submissionId, user.id]);
    } else {
      const submission = await db.query(
        `INSERT INTO public.submissions (
          user_id, industry, role, occupation, city, display_name, is_anonymous, answers,
          roundtable_interest, publish_to_wall, use_voice_in_roundtable, contact_me
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id`,
        [
          user.id,
          body.industry,
          body.role,
          body.occupation,
          body.city,
          body.isAnonymous ? null : body.displayName?.trim() || null,
          body.isAnonymous,
          answerSummary,
          body.roundtableInterest,
          body.publishToWall,
          body.useVoiceInRoundtable,
          body.contactMe
        ]
      );
      submissionId = submission.rows[0].id;
    }
    const displayName = body.isAnonymous ? "A participant" : body.displayName?.trim() || "A participant";
    for (const answer of Object.values(body.answers)) {
      await db.query(
        `INSERT INTO public.voice_notes (
          submission_id, user_id, industry, role, display_name, transcript,
          audio_data, audio_mime_type, duration_seconds, publish_to_wall
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          submissionId,
          user.id,
          body.industry,
          body.role,
          displayName,
          answer.text?.trim() || answer.choice.trim() || "Shared by voice",
          answer.audioData || null,
          answer.audioMimeType || null,
          answer.durationSeconds ?? null,
          body.publishToWall
        ]
      );
    }
    await db.query("COMMIT");
    sendJson(res, 200, JSON.stringify({ submission_id: submissionId }));
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

async function handleVoices(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, JSON.stringify({ error: "Method not allowed." }));
    return;
  }
  const result = await pool.query(
    `SELECT id, industry, role, display_name, transcript, audio_data, duration_seconds, created_at
     FROM public.voice_notes
     WHERE publish_to_wall = true
     ORDER BY created_at DESC
     LIMIT 100`
  );
  sendJson(res, 200, JSON.stringify(result.rows));
}

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, JSON.stringify({ error: "Method not allowed." }));
    return;
  }

  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = normalize(join(root, relativePath));
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    sendJson(res, 403, JSON.stringify({ error: "Forbidden." }));
    return;
  }

  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    if (req.method === "HEAD") res.end();
    else createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, JSON.stringify({ error: "Not found." }));
  }
}

const authHandler = toNodeHandler(auth);

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  try {
    if (pathname === "/api/auth/set-password") {
      await handleSetPassword(req, res);
      return;
    }
    if (pathname.startsWith("/api/auth/")) {
      await authHandler(req, res);
      return;
    }
    if (pathname === "/api/submissions") {
      await handleSubmission(req, res);
      return;
    }
    if (pathname === "/api/voices") {
      await handleVoices(req, res);
      return;
    }
    if (pathname === "/api/neon-auth-webhook") {
      let body;
      try {
        body = await readRequestBody(req);
      } catch {
        sendJson(res, 413, JSON.stringify({ error: "Request body is too large." }));
        return;
      }
      const result = await handleNeonAuthWebhook({ method: req.method, headers: req.headers, body });
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    const status = error.message === "Invalid JSON." || error.message?.includes("required") || error.message?.includes("invalid") || error.message?.includes("too large") ? 400 : 500;
    sendJson(res, status, JSON.stringify({ error: status === 500 ? "The request could not be completed." : error.message }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Voices at the Table server listening on ${port}`);
});
