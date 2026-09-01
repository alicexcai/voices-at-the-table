import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const MAX_BODY_BYTES = 64 * 1024;
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_NEON_AUTH_JWKS_URL = "https://ep-muddy-sound-av88fs1z.neonauth.c-11.us-east-1.aws.neon.tech/neondb/auth/.well-known/jwks.json";
const deliveredEvents = new Map();
const inFlightEvents = new Map();
let jwksCache = { expiresAt: 0, keys: null };

class WebhookError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const response = (status, body = "") => ({
  status,
  body,
  headers: { "content-type": "application/json; charset=utf-8" }
});

const headerValue = (headers, name) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const decodeBase64Url = (value) => {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new WebhookError(401, "Invalid signature.");
  return Buffer.from(value, "base64url");
};

const encodeBase64Url = (value) => Buffer.from(value).toString("base64url");

async function readRequestBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new WebhookError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function getVerificationKey(kid) {
  const now = Date.now();
  if (!jwksCache.keys || jwksCache.expiresAt <= now) {
    const jwksUrl = process.env.NEON_AUTH_JWKS_URL || DEFAULT_NEON_AUTH_JWKS_URL;
    const jwksResponse = await fetch(jwksUrl, { headers: { accept: "application/json" } });
    if (!jwksResponse.ok) throw new WebhookError(503, "Neon signing keys are unavailable.");
    const jwks = await jwksResponse.json();
    jwksCache = { keys: Array.isArray(jwks.keys) ? jwks.keys : [], expiresAt: now + 10 * 60 * 1000 };
  }
  const jwk = jwksCache.keys.find((key) => key.kid === kid && key.kty === "OKP" && key.crv === "Ed25519");
  if (!jwk) throw new WebhookError(401, "Unknown signing key.");
  return subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
}

async function verifySignature(headers, rawBody) {
  const signature = headerValue(headers, "x-neon-signature");
  const signatureKid = headerValue(headers, "x-neon-signature-kid");
  const timestamp = headerValue(headers, "x-neon-timestamp");
  if (!signature || !signatureKid || !timestamp) throw new WebhookError(401, "Missing signature.");

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > SIGNATURE_MAX_AGE_MS) {
    throw new WebhookError(401, "Expired signature.");
  }

  const parts = signature.split(".");
  if (parts.length !== 3 || parts[1] !== "") throw new WebhookError(401, "Invalid signature.");
  let protectedHeader;
  try {
    protectedHeader = JSON.parse(decodeBase64Url(parts[0]).toString("utf8"));
  } catch {
    throw new WebhookError(401, "Invalid signature.");
  }
  if (protectedHeader.alg !== "EdDSA" || protectedHeader.kid !== signatureKid) throw new WebhookError(401, "Invalid signature.");

  const payloadB64 = encodeBase64Url(rawBody);
  const signaturePayloadB64 = encodeBase64Url(`${timestamp}.${payloadB64}`);
  const signingInput = Buffer.from(`${parts[0]}.${signaturePayloadB64}`);
  const key = await getVerificationKey(signatureKid);
  const valid = await subtle.verify(
    { name: "Ed25519" },
    key,
    decodeBase64Url(parts[2]),
    signingInput
  );
  if (!valid) throw new WebhookError(401, "Invalid signature.");
}

function getTwilioConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!accountSid || !authToken || !serviceSid) throw new WebhookError(503, "Twilio Verify is not configured.");
  return { accountSid, authToken, serviceSid };
}

async function sendTwilioVerification({ to, otpCode }) {
  const { accountSid, authToken, serviceSid } = getTwilioConfig();
  const params = new URLSearchParams({ To: to, Channel: "sms", CustomCode: otpCode });
  const twilioResponse = await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}/Verifications`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  if (!twilioResponse.ok) throw new WebhookError(502, "Twilio Verify could not send the code.");
  const verification = await twilioResponse.json();
  if (!verification.sid) throw new WebhookError(502, "Twilio Verify did not return a verification ID.");
  return verification.sid;
}

async function approveTwilioVerification({ verificationSid }) {
  const { accountSid, authToken, serviceSid } = getTwilioConfig();
  const params = new URLSearchParams({ Status: "approved" });
  const twilioResponse = await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}/Verifications/${encodeURIComponent(verificationSid)}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  if (!twilioResponse.ok) throw new WebhookError(502, "Twilio Verify could not record the verification.");
}

function pruneDeliveredEvents() {
  const now = Date.now();
  for (const [eventId, delivery] of deliveredEvents) {
    if (delivery.expiresAt <= now) deliveredEvents.delete(eventId);
  }
}

async function deliverOnce(eventId, details) {
  pruneDeliveredEvents();
  if (deliveredEvents.has(eventId)) return;
  if (!inFlightEvents.has(eventId)) {
    const delivery = sendTwilioVerification(details)
      .then((verificationSid) => deliveredEvents.set(eventId, {
        expiresAt: Date.now() + 15 * 60 * 1000,
        to: details.to,
        verificationSid
      }))
      .finally(() => inFlightEvents.delete(eventId));
    inFlightEvents.set(eventId, delivery);
  }
  await inFlightEvents.get(eventId);
}

async function approveLatestVerification(phoneNumber) {
  pruneDeliveredEvents();
  const delivery = [...deliveredEvents.values()].reverse().find((item) => item.to === phoneNumber);
  if (delivery) await approveTwilioVerification({ verificationSid: delivery.verificationSid });
}

export async function handleNeonAuthWebhook({ method, headers, body }) {
  if (method !== "POST") return response(405, JSON.stringify({ error: "Method not allowed." }));
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  if (!rawBody.length) return response(400, JSON.stringify({ error: "Request body is required." }));

  try {
    await verifySignature(headers, rawBody);
    const event = JSON.parse(rawBody.toString("utf8"));
    const eventType = headerValue(headers, "x-neon-event-type");
    const eventId = headerValue(headers, "x-neon-event-id") || event.event_id;
    if (eventType !== event.event_type || !eventId || event.event_id !== eventId) {
      throw new WebhookError(400, "Unsupported webhook event.");
    }

    if (eventType === "phone_number.verified") {
      const phoneNumber = event.event_data?.phone_number || event.user?.phone_number;
      if (!/^\+[1-9]\d{1,14}$/.test(phoneNumber || "")) {
        throw new WebhookError(400, "The verified phone number is missing.");
      }
      await approveLatestVerification(phoneNumber);
      return response(200, JSON.stringify({ recorded: true }));
    }

    if (eventType !== "send.otp") throw new WebhookError(400, "Unsupported webhook event.");
    const eventData = event.event_data || {};
    if (eventData.delivery_preference !== "sms") {
      throw new WebhookError(400, "This endpoint only handles SMS OTP delivery.");
    }
    const to = event.user?.phone_number;
    const otpCode = eventData.otp_code;
    if (!/^\+[1-9]\d{1,14}$/.test(to || "") || !/^\d{6}$/.test(otpCode || "")) {
      throw new WebhookError(400, "The SMS OTP payload is incomplete.");
    }

    await deliverOnce(eventId, { to, otpCode });
    return response(200, JSON.stringify({ delivered: true }));
  } catch (error) {
    if (error instanceof SyntaxError) return response(400, JSON.stringify({ error: "Invalid JSON." }));
    if (error instanceof WebhookError) return response(error.status, JSON.stringify({ error: error.message }));
    return response(500, JSON.stringify({ error: "Webhook delivery failed." }));
  }
}

export { readRequestBody };
