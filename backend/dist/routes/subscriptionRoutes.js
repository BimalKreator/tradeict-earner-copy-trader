import { Router } from "express";
import { createSubscriptionController } from "../controllers/subscriptionController.js";
import { authenticateJwt } from "../middleware/authMiddleware.js";
export function createSubscriptionRoutes(prisma) {
    const router = Router();
    const jwtAuth = authenticateJwt();
    const subscription = createSubscriptionController(prisma);
    router.post("/subscribe", jwtAuth, subscription.subscribe);
    return router;
}
//# sourceMappingURL=subscriptionRoutes.js.map