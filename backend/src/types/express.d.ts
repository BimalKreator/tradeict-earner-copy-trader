declare global {
  namespace Express {
    interface Request {
      /** Set by JWT middleware after verifying Bearer token (`sub` claim). */
      userId?: string;
    }
  }
}

export {};
