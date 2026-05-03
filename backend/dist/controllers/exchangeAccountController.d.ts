import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
export declare function createExchangeAccountController(prisma: PrismaClient): {
    list: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    create: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    remove: (req: Request, res: Response, next: NextFunction) => Promise<void>;
};
//# sourceMappingURL=exchangeAccountController.d.ts.map