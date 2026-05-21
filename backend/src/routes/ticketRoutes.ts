import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { authenticateJwt, requireAdmin } from "../middleware/authMiddleware.js";
import { createTicketController } from "../controllers/ticketController.js";

export function createTicketRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const tickets = createTicketController(prisma);

  router.post("/", jwtAuth, tickets.createTicket);
  router.get("/", jwtAuth, tickets.listMyTickets);
  router.get("/:id", jwtAuth, tickets.getMyTicket);
  router.post("/:id/reply", jwtAuth, tickets.replyToTicket);
  router.post("/:id/close", jwtAuth, tickets.closeMyTicket);

  return router;
}

export function createAdminTicketRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt();
  const admin = requireAdmin(prisma);
  const tickets = createTicketController(prisma);

  router.get("/", jwtAuth, admin, tickets.listAllTickets);
  router.get("/:id", jwtAuth, admin, tickets.getAdminTicket);
  router.post("/:id/reply", jwtAuth, admin, tickets.adminReply);
  router.post("/:id/close", jwtAuth, admin, tickets.adminCloseTicket);

  return router;
}
