import { Router } from "express";
import { createPublicController } from "../controllers/publicController.js";

export function createPublicRoutes(): Router {
  const router = Router();
  const publicCtrl = createPublicController();

  router.post("/apply-expert", publicCtrl.applyExpert);

  return router;
}
