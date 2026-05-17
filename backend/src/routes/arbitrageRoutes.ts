import { Router } from "express";
import { authenticateJwt } from "../middleware/authMiddleware.js";
import { createArbitrageController } from "../controllers/arbitrageController.js";

export function createArbitrageRoutes(): Router {
  const router = Router();
  const controller = createArbitrageController();
  const jwtAuth = authenticateJwt();

  router.get("/dex", jwtAuth, controller.getDexArbitrage);

  return router;
}
