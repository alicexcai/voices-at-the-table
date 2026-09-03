import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { pool } from "./db.js";

const root = fileURLToPath(new URL(".", import.meta.url)).replace(/[\\/]+$/, "");
const port = Number(process.env.PORT || 3000);
const MAX_JSON_BYTES = 256 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

let storageClient;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestError(413, "The upload is too large.");
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const body = await readBody(req, MAX_JSON_BYTES);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new RequestError(400, "Invalid JSON.");
  }
}

function isString(value, maxLength = 10_000) {
  return typeof value === "string" && value.length <= maxLength;
}

function isBoolean(value) {
  return typeof value === "boolean";
}

function requireDraftToken(req) {
  const token = req.headers["x-survey-token"];
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new RequestError(401, "This survey draft is not available on this device.");
  }

  return createHash("sha256").update(token).digest("hex");
}

function normalizeAnswers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "Survey answers are invalid.");
  }

  const entries = Object.entries(value);
  if (entries.length > 3) throw new RequestError(400, "Survey answers are invalid.");

  return Object.fromEntries(entries.map(([questionId, answer]) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(questionId) || !answer || typeof answer !== "object" || Array.isArray(answer)) {
      throw new RequestError(400, "Survey answers are invalid.");
    }

    if (!isString(answer.choice || "", 500) || !isString(answer.text || "", 10_000)) {
      throw new RequestError(400, "Survey answers are invalid.");
    }

    return [questionId, {
      choice: (answer.choice || "").trim(),
      text: (answer.text || "").trim()
    }];
  }));
}

function validateDraft(body) {
  if (!body || typeof body !== "object") throw new RequestError(400, "Survey data is invalid.");

  const currentStep = Number(body.currentStep);
  const completedThrough = Number(body.completedThrough);
  if (!Number.isInteger(currentStep) || currentStep < 0 || currentStep > 3 || !Number.isInteger(completedThrough) || completedThrough < -1 || completedThrough > 3) {
    throw new RequestError(400, "Survey progress is invalid.");
  }

  if (!isBoolean(body.recordingConsent) || !isBoolean(body.isAnonymous) || !isBoolean(body.roundtableInterest) || !isBoolean(body.useVoiceInRoundtable) || !isBoolean(body.contactMe)) {
    throw new RequestError(400, "Survey preferences are invalid.");
  }

  const fields = [
    ["industry", 100],
    ["role", 500],
    ["occupation", 200],
    ["city", 200],
    ["displayName", 200],
    ["contactEmail", 320],
    ["contactPhone", 60]
  ];

  for (const [field, maxLength] of fields) {
    if (!isString(body[field], maxLength)) {
      throw new RequestError(400, "Survey data is invalid.");
    }
  }

  return {
    currentStep,
    completedThrough,
    recordingConsent: body.recordingConsent,
    industry: body.industry.trim(),
    role: body.role.trim(),
    occupation: body.occupation.trim(),
    city: body.city.trim(),
    displayName: body.displayName.trim(),
    isAnonymous: body.isAnonymous,
    contactEmail: body.contactEmail.trim(),
    contactPhone: body.contactPhone.trim(),
    answers: normalizeAnswers(body.answers || {}),
    roundtableInterest: body.roundtableInterest,
    useVoiceInRoundtable: body.useVoiceInRoundtable,
    contactMe: body.contactMe
  };
}

function getStorage() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new RequestError(503, "Audio uploads are not configured yet. You can continue with a written response.");
  }

  if (!storageClient) {
    storageClient = new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey }
    });
  }

  return { client: storageClient, bucket };
}

function extensionForMimeType(mimeType) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

async function getDraft(draftId, tokenHash) {
  const result = await pool.query(
    `SELECT id::text AS draft_id, recording_consent, industry, role, occupation, city,
            display_name, is_anonymous, contact_email, contact_phone, answers,
            roundtable_interest, use_voice_in_roundtable, contact_me, current_step,
            completed_through, submitted_at
     FROM public.anonymous_survey_drafts
     WHERE id = $1 AND edit_token_hash = $2`,
    [draftId, tokenHash]
  );

  return result.rows[0] || null;
}

async function getDraftAudio(draftId) {
  const result = await pool.query(
    `SELECT id::text AS audio_id, question_id, audio_mime_type, duration_seconds
     FROM public.anonymous_survey_audio
     WHERE draft_id = $1`,
    [draftId]
  );

  return result.rows;
}

async function handleDrafts(req, res, pathname) {
  if (pathname === "/api/drafts") {
    if (req.method !== "POST") throw new RequestError(405, "Method not allowed.");

    const draftId = randomUUID();
    const editToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(editToken).digest("hex");
    await pool.query(
      `INSERT INTO public.anonymous_survey_drafts (id, edit_token_hash)
       VALUES ($1, $2)`,
      [draftId, tokenHash]
    );
    sendJson(res, 201, { draftId, editToken });
    return;
  }

  const match = pathname.match(/^\/api\/drafts\/([0-9a-fA-F-]{36})(?:\/audio\/([a-zA-Z0-9_-]{1,64}))?(?:\/(submit))?$/);
  if (!match) throw new RequestError(404, "Not found.");

  const [, draftId, questionId, action] = match;
  const tokenHash = requireDraftToken(req);
  const draft = await getDraft(draftId, tokenHash);
  if (!draft) throw new RequestError(404, "This survey draft is not available on this device.");

  if (questionId) {
    if (action) throw new RequestError(404, "Not found.");
    await handleDraftAudio(req, res, draft, tokenHash, questionId);
    return;
  }

  if (action === "submit") {
    if (req.method !== "POST") throw new RequestError(405, "Method not allowed.");
    await submitDraft(res, draft);
    return;
  }

  if (req.method === "GET") {
    sendJson(res, 200, { ...draft, audio: await getDraftAudio(draftId) });
    return;
  }

  if (req.method !== "PUT") throw new RequestError(405, "Method not allowed.");

  const data = validateDraft(await readJsonBody(req));
  const updated = await pool.query(
    `UPDATE public.anonymous_survey_drafts
     SET recording_consent = $1, industry = $2, role = $3, occupation = $4, city = $5,
         display_name = $6, is_anonymous = $7, contact_email = $8, contact_phone = $9,
         answers = $10, roundtable_interest = $11, use_voice_in_roundtable = $12,
         contact_me = $13, current_step = $14, completed_through = $15, updated_at = now()
     WHERE id = $16 AND edit_token_hash = $17
     RETURNING updated_at`,
    [
      data.recordingConsent,
      data.industry || null,
      data.role || null,
      data.occupation || null,
      data.city || null,
      data.isAnonymous ? null : data.displayName || null,
      data.isAnonymous,
      data.contactEmail || null,
      data.contactPhone || null,
      data.answers,
      data.roundtableInterest,
      data.useVoiceInRoundtable,
      data.contactMe,
      data.currentStep,
      data.completedThrough,
      draftId,
      tokenHash
    ]
  );

  sendJson(res, 200, { ok: true, updatedAt: updated.rows[0].updated_at });
}

async function handleDraftAudio(req, res, draft, tokenHash, questionId) {
  if (req.method === "DELETE") {
    const existing = await pool.query(
      `SELECT object_key FROM public.anonymous_survey_audio
       WHERE draft_id = $1 AND question_id = $2`,
      [draft.draft_id, questionId]
    );
    const recording = existing.rows[0];
    if (!recording) {
      sendJson(res, 200, { ok: true });
      return;
    }
    const { client, bucket } = getStorage();
    await pool.query(
      `DELETE FROM public.anonymous_survey_audio
       WHERE draft_id = $1 AND question_id = $2`,
      [draft.draft_id, questionId]
    );
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: recording.object_key }));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET") {
    const audio = await pool.query(
      `SELECT id::text AS audio_id, object_key, audio_mime_type
       FROM public.anonymous_survey_audio
       WHERE draft_id = $1 AND question_id = $2`,
      [draft.draft_id, questionId]
    );
    const recording = audio.rows[0];
    if (!recording) throw new RequestError(404, "This recording was not found.");

    const { client, bucket } = getStorage();
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: recording.object_key }));
    res.writeHead(200, {
      "content-type": recording.audio_mime_type,
      "cache-control": "private, max-age=3600"
    });
    object.Body.pipe(res);
    return;
  }

  if (req.method !== "POST") throw new RequestError(405, "Method not allowed.");

  const contentType = (req.headers["content-type"] || "audio/webm").split(";")[0].trim();
  if (!/^audio\/[a-z0-9.+-]+$/i.test(contentType)) {
    throw new RequestError(400, "The recording type is not supported.");
  }

  const durationSeconds = Number(req.headers["x-audio-duration"]);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
    throw new RequestError(400, "The recording duration is invalid.");
  }

  const body = await readBody(req, MAX_AUDIO_BYTES);
  if (!body.length) throw new RequestError(400, "No audio was captured.");

  const { client, bucket } = getStorage();
  const objectKey = `voices/${draft.draft_id}/${questionId}/${randomUUID()}.${extensionForMimeType(contentType)}`;
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: body,
    ContentType: contentType
  }));

  const db = await pool.connect();
  let previousObjectKey = null;
  try {
    await db.query("BEGIN");
    const previous = await db.query(
      `SELECT object_key FROM public.anonymous_survey_audio
       WHERE draft_id = $1 AND question_id = $2
       FOR UPDATE`,
      [draft.draft_id, questionId]
    );
    previousObjectKey = previous.rows[0]?.object_key || null;
    const recording = await db.query(
      `INSERT INTO public.anonymous_survey_audio (
         id, draft_id, question_id, object_key, audio_mime_type, duration_seconds
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (draft_id, question_id)
       DO UPDATE SET object_key = EXCLUDED.object_key,
                     audio_mime_type = EXCLUDED.audio_mime_type,
                     duration_seconds = EXCLUDED.duration_seconds,
                     updated_at = now()
       RETURNING id::text AS audio_id, audio_mime_type, duration_seconds`,
      [randomUUID(), draft.draft_id, questionId, objectKey, contentType, durationSeconds]
    );
    await db.query(
      `UPDATE public.anonymous_survey_drafts
       SET updated_at = now()
       WHERE id = $1`,
      [draft.draft_id]
    );
    await db.query("COMMIT");
    sendJson(res, 201, { ...recording.rows[0] });
  } catch (error) {
    await db.query("ROLLBACK");
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })).catch(() => {});
    throw error;
  } finally {
    db.release();
  }

  if (previousObjectKey && previousObjectKey !== objectKey) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: previousObjectKey })).catch(() => {});
  }
}

async function submitDraft(res, draft) {
  const answers = draft.answers && typeof draft.answers === "object" ? draft.answers : {};
  const recordings = await pool.query(
    `SELECT question_id FROM public.anonymous_survey_audio WHERE draft_id = $1`,
    [draft.draft_id]
  );
  const recordedQuestionIds = new Set(recordings.rows.map((recording) => recording.question_id));
  const hasCompletedAnswer = Object.entries(answers).some(([questionId, answer]) =>
    isString(answer?.choice || "", 500) && answer.choice.trim() &&
    (isString(answer?.text || "", 10_000) && answer.text.trim() || recordedQuestionIds.has(questionId))
  );

  if (!draft.recording_consent) throw new RequestError(400, "Please acknowledge that your responses will be recorded.");
  if (!draft.industry || !draft.role || !draft.occupation || !draft.city) {
    throw new RequestError(400, "Complete the About and Details steps before submitting.");
  }
  if (!hasCompletedAnswer) throw new RequestError(400, "Complete at least one prompt before submitting.");

  await pool.query(
    `UPDATE public.anonymous_survey_drafts
     SET publish_to_wall = true, submitted_at = now(), completed_through = 3,
         current_step = 3, updated_at = now()
     WHERE id = $1`,
    [draft.draft_id]
  );

  sendJson(res, 200, { draftId: draft.draft_id });
}

async function handlePublicAudio(req, res, pathname) {
  if (req.method !== "GET") throw new RequestError(405, "Method not allowed.");
  const audioId = pathname.split("/").at(-1);
  if (!/^[0-9a-fA-F-]{36}$/.test(audioId)) throw new RequestError(404, "Not found.");

  const result = await pool.query(
    `SELECT a.object_key, a.audio_mime_type
     FROM public.anonymous_survey_audio AS a
     JOIN public.anonymous_survey_drafts AS d ON d.id = a.draft_id
     WHERE a.id = $1 AND d.submitted_at IS NOT NULL AND d.publish_to_wall = true`,
    [audioId]
  );
  const recording = result.rows[0];
  if (!recording) throw new RequestError(404, "This recording was not found.");

  const { client, bucket } = getStorage();
  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: recording.object_key }));
  res.writeHead(200, {
    "content-type": recording.audio_mime_type,
    "cache-control": "public, max-age=86400"
  });
  object.Body.pipe(res);
}

async function handleVoices(req, res) {
  if (req.method !== "GET") throw new RequestError(405, "Method not allowed.");

  const result = await pool.query(
    `SELECT d.industry, d.role, d.display_name, answer.question_id,
            COALESCE(NULLIF(answer.response ->> 'text', ''), answer.response ->> 'choice') AS transcript,
            a.id::text AS audio_id, a.duration_seconds, d.submitted_at
     FROM public.anonymous_survey_drafts AS d
     CROSS JOIN LATERAL jsonb_each(d.answers) AS answer(question_id, response)
     LEFT JOIN public.anonymous_survey_audio AS a
       ON a.draft_id = d.id AND a.question_id = answer.question_id
     WHERE d.submitted_at IS NOT NULL
       AND d.publish_to_wall = true
       AND (NULLIF(answer.response ->> 'text', '') IS NOT NULL OR a.id IS NOT NULL)
     ORDER BY d.submitted_at DESC, answer.question_id
     LIMIT 100`
  );
  sendJson(res, 200, result.rows);
}

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") throw new RequestError(405, "Method not allowed.");

  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = normalize(join(root, relativePath));
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) throw new RequestError(403, "Forbidden.");

  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    if (req.method === "HEAD") res.end();
    else createReadStream(filePath).pipe(res);
  } catch {
    throw new RequestError(404, "Not found.");
  }
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  try {
    if (pathname === "/api/drafts" || pathname.startsWith("/api/drafts/")) {
      await handleDrafts(req, res, pathname);
      return;
    }
    if (pathname.startsWith("/api/audio/")) {
      await handlePublicAudio(req, res, pathname);
      return;
    }
    if (pathname === "/api/voices") {
      await handleVoices(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = error instanceof RequestError ? error.status : 500;
    const message = error instanceof RequestError ? error.message : "The request could not be completed.";
    sendJson(res, status, { error: message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Voices at the Table server listening on ${port}`);
});
