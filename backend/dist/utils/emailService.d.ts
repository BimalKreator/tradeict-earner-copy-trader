import nodemailer from "nodemailer";
export type OtpEmailPurpose = "Sign Up" | "Login";
/**
 * Brevo (formerly Sendinblue) SMTP — configure via environment (same keys work with Brevo’s SMTP relay):
 * - SMTP_HOST — e.g. smtp-relay.brevo.com
 * - SMTP_PORT — typically 587 (STARTTLS) or 465 (implicit TLS)
 * - SMTP_USER — your Brevo SMTP login
 * - SMTP_PASS — your Brevo SMTP key
 * - SMTP_SECURE — optional; set "true" for port 465
 * - EMAIL_FROM — optional From display (defaults to SMTP_USER)
 */
export declare function createMailTransport(): nodemailer.Transporter;
/**
 * Sends a branded OTP email via Brevo-compatible SMTP (nodemailer).
 */
export declare function sendOtpEmail(to: string, otp: string, purpose: OtpEmailPurpose): Promise<void>;
//# sourceMappingURL=emailService.d.ts.map