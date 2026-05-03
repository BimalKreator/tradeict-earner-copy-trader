import { Router } from "express";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createExchangeAccountController } from "../controllers/exchangeAccountController.js";
export function createExchangeAccountRoutes(prisma) {
    const router = Router();
    const jwtAuth = authenticateJwt();
    const ctrl = createExchangeAccountController(prisma);
    router.get("/", jwtAuth, ctrl.list);
    router.post("/", jwtAuth, ctrl.create);
    router.delete("/:id", jwtAuth, ctrl.remove);
    return router;
}
//# sourceMappingURL=exchangeAccountRoutes.js.map