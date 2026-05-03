import { Router } from "express";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createUserController } from "../controllers/userController.js";
export function createUserRoutes(prisma) {
    const router = Router();
    const jwtAuth = authenticateJwt();
    const user = createUserController(prisma);
    router.get("/me", jwtAuth, user.getMe);
    router.patch("/me", jwtAuth, user.patchMe);
    return router;
}
//# sourceMappingURL=userRoutes.js.map