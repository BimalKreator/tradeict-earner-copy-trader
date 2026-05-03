import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
/**
 * Requires `Authorization: Bearer <jwt>` with valid JWT_SECRET signature.
 * Sets `req.userId` from the `sub` claim.
 */
export declare function authenticateJwt(): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Must run after `authenticateJwt`. Loads user and requires `role === ADMIN`.
 */
export declare function requireAdmin(prisma: PrismaClient): (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=authMiddleware.d.ts.map