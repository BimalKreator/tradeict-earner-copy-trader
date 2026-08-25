/**
 * Force noop mail after dotenv — overrides any EMAIL_TRANSPORT in .env.
 * Imported by harness runner only.
 */
process.env.EMAIL_TRANSPORT = "noop";
