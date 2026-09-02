import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { phoneNumber } from "better-auth/plugins";
import { sendTwilioOtp, verifyTwilioOtp } from "./twilio.js";
import { pool } from "./db.js";

const authSecret = process.env.BETTER_AUTH_SECRET;
if (!authSecret) throw new Error("BETTER_AUTH_SECRET is required.");

const temporaryEmailFor = (phoneNumber) => {
  const digest = createHash("sha256").update(phoneNumber).digest("hex");
  return `phone-${digest}@phone.invalid`;
};

export const auth = betterAuth({
  secret: authSecret,
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  database: pool,
  trustedOrigins: [
    process.env.BETTER_AUTH_URL || "http://localhost:3000",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8
  },
  plugins: [
    phoneNumber({
      expiresIn: 300,
      allowedAttempts: 3,
      requireVerification: true,
      sendOTP: async ({ phoneNumber: recipient }) => {
        await sendTwilioOtp(recipient);
      },
      verifyOTP: async ({ phoneNumber: recipient, code }) => verifyTwilioOtp(recipient, code),
      signUpOnVerification: {
        getTempEmail: temporaryEmailFor,
        getTempName: () => "Participant"
      }
    })
  ]
});
