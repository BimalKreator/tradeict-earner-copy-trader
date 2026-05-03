import type { NextFunction, Request, Response } from "express";
import { type PrismaClient } from "@prisma/client";
export declare function createAuthController(prisma: PrismaClient): {
    sendSignupOtp: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    registerWithOtp: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    sendLoginOtp: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    verifyOtp: (req: Request, res: Response, next: NextFunction) => Promise<void>;
};
//# sourceMappingURL=authController.d.ts.map