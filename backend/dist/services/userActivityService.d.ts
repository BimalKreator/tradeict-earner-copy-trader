import type { PrismaClient } from "@prisma/client";
export declare function logUserActivity(prisma: PrismaClient, args: {
    userId: string;
    kind: string;
    message: string;
}): Promise<void>;
//# sourceMappingURL=userActivityService.d.ts.map