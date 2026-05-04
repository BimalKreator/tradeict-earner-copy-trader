import { Router } from "express";
import { createSubscriptionController } from "../controllers/subscriptionController.js";
import { authenticateJwt } from "../middleware/authMiddleware.js";
export function createSubscriptionRoutes(prisma) {
    const router = Router();
    const jwtAuth = authenticateJwt();
    const subscription = createSubscriptionController(prisma);
    router.post("/subscribe", jwtAuth, subscription.subscribe);
    router.get("/mine", jwtAuth, subscription.listMySubscriptions);
    /** Marketplace list: same payload as GET /strategies (URLs differ by mount prefix). */
    router.get("/", jwtAuth, subscription.listStrategies);
    router.get("/strategies", jwtAuth, subscription.listStrategies);
    router.get("/strategies/:id", jwtAuth, subscription.getStrategy);
    return router;
}
//# sourceMappingURL=subscriptionRoutes.js.map