import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
export declare function createUserController(prisma: PrismaClient): {
    getMe: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    patchMe: (req: Request, res: Response, next: NextFunction) => Promise<void>;
};
//# sourceMappingURL=userController.d.ts.map