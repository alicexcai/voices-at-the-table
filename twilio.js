const getTwilioConfig = () => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!accountSid || !authToken || !serviceSid) throw new Error("Twilio Verify is not configured.");
  return { accountSid, authToken, serviceSid };
};

const twilioRequest = async (path, params) => {
  const { accountSid, authToken } = getTwilioConfig();
  const result = await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(process.env.TWILIO_VERIFY_SERVICE_SID)}/${path}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(params)
  });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(payload.message || "Twilio Verify request failed.");
  return payload;
};

export async function sendTwilioOtp(phoneNumber) {
  const { serviceSid } = getTwilioConfig();
  const payload = await twilioRequest(`Verifications`, {
    To: phoneNumber,
    Channel: "sms"
  });
  if (payload.service_sid !== serviceSid || payload.status !== "pending") {
    throw new Error("Twilio Verify did not accept the phone verification request.");
  }
}

export async function verifyTwilioOtp(phoneNumber, code) {
  const payload = await twilioRequest("VerificationCheck", {
    To: phoneNumber,
    Code: code
  });
  return payload.status === "approved";
}
