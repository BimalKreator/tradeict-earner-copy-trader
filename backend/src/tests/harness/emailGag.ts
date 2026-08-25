/**
 * Side-effect module: gag SMTP before harness scenario modules run.
 * dotenv will not override an already-set EMAIL_TRANSPORT.
 */
process.env.EMAIL_TRANSPORT = "noop";
