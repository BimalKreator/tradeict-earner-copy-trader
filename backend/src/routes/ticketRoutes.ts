import { Router } from "express";
import { AdminRole, type PrismaClient } from "@prisma/client";
import {
  authenticateJwt,
  authorizeRoles,
  requireAdmin,
} from "../middleware/authMiddleware.js";
import { createAdminAuditMiddleware } from "../middleware/adminAuditMiddleware.js";
import { createTicketController } from "../controllers/ticketController.js";

export function createTicketRoutes(prisma: PrismaClient): Router {
  const router = Router();
  const jwtAuth = authenticateJwt(prisma);
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
  const tickets = createTicketController(prisma);

  router.use(
    authenticateJwt(prisma),
    requireAdmin(prisma),
    authorizeRoles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER),
    createAdminAuditMiddleware(prisma),
  );

  router.get("/", tickets.listAllTickets);
  router.get("/:id", tickets.getAdminTicket);
  router.post("/:id/reply", tickets.adminReply);
  router.post("/:id/close", tickets.adminCloseTicket);

  return router;
}
