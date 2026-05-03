import type { NextFunction, Request, Response } from "express";
import { type PrismaClient } from "@prisma/client";
export declare function createWalletController(prisma: PrismaClient): {
    topUp: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    listTransactions: (_req: Request, res: Response, next: NextFunction) => Promise<void>;
    approve: (req: Request, res: Response, next: NextFunction) => Promise<void>;
};
//# sourceMappingURL=walletController.d.ts.map