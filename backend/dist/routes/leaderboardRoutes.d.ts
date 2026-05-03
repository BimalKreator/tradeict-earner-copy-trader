import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
/** e.g. bob@gmail.com → b***@gmail.com */
export declare function maskEmail(email: string): string;
export declare function createLeaderboardRoutes(prisma: PrismaClient): Router;
//# sourceMappingURL=leaderboardRoutes.d.ts.map