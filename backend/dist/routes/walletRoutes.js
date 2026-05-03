import { Router } from "express";
import { createWalletController } from "../controllers/walletController.js";
import { authenticateJwt, requireAdmin, } from "../middleware/authMiddleware.js";
export function createWalletRoutes(prisma) {
    const router = Router();
    const jwtAuth = authenticateJwt();
    const adminOnly = [jwtAuth, requireAdmin(prisma)];
    const wallet = createWalletController(prisma);
    router.post("/topup", jwtAuth, wallet.topUp);
    router.get("/transactions", ...adminOnly, wallet.listTransactions);
    router.post("/approve", ...adminOnly, wallet.approve);
    return router;
}
//# sourceMappingURL=walletRoutes.js.map