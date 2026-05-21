import type { NextFunction, Request, Response } from "express";
import { Role, TicketStatus, type PrismaClient } from "@prisma/client";
import {
  getTicketForAdmin,
  getTicketForUser,
  mapTicketDetail,
  mapTicketSummary,
  sortTicketsForAdmin,
} from "../services/ticketService.js";

const MAX_SUBJECT = 200;
const MAX_MESSAGE = 8000;

function trimMessage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function trimSubject(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export function createTicketController(prisma: PrismaClient) {
  async function createTicket(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body as { subject?: unknown; message?: unknown };
      const subject = trimSubject(body.subject);
      const message = trimMessage(body.message);

      if (!subject) {
        res.status(400).json({ error: "subject is required" });
        return;
      }
      if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
      }
      if (subject.length > MAX_SUBJECT) {
        res.status(400).json({ error: `subject must be at most ${MAX_SUBJECT} characters` });
        return;
      }
      if (message.length > MAX_MESSAGE) {
        res.status(400).json({ error: `message must be at most ${MAX_MESSAGE} characters` });
        return;
      }

      const ticket = await prisma.ticket.create({
        data: {
          userId,
          subject,
          status: TicketStatus.OPEN,
          messages: {
            create: {
              senderId: userId,
              isAdmin: false,
              message,
            },
          },
        },
        include: {
          user: { select: { id: true, email: true, name: true } },
          messages: {
            include: {
              sender: { select: { id: true, email: true, name: true } },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      });

      res.status(201).json(mapTicketDetail(ticket, "user"));
    } catch (err) {
      next(err);
    }
  }

  async function listMyTickets(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const tickets = await prisma.ticket.findMany({
        where: { userId },
        include: {
          messages: {
            select: { isAdmin: true, message: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          _count: { select: { messages: true } },
        },
        orderBy: { updatedAt: "desc" },
      });

      const items = tickets
        .map((t) => mapTicketSummary(t, "user"))
        .sort((a, b) => {
          if (a.unread !== b.unread) return a.unread ? -1 : 1;
          if (a.status !== b.status) {
            return a.status === TicketStatus.OPEN ? -1 : 1;
          }
          return (
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          );
        });

      res.json({ tickets: items });
    } catch (err) {
      next(err);
    }
  }

  async function getMyTicket(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const id = String(req.params.id ?? "").trim();
      if (!id) {
        res.status(400).json({ error: "Ticket id is required" });
        return;
      }

      const ticket = await getTicketForUser(prisma, id, userId);
      if (!ticket) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }

      res.json(mapTicketDetail(ticket, "user"));
    } catch (err) {
      next(err);
    }
  }

  async function replyToTicket(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const id = String(req.params.id ?? "").trim();
      const message = trimMessage((req.body as { message?: unknown }).message);

      if (!id) {
        res.status(400).json({ error: "Ticket id is required" });
        return;
      }
      if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
      }
      if (message.length > MAX_MESSAGE) {
        res.status(400).json({ error: `message must be at most ${MAX_MESSAGE} characters` });
        return;
      }

      const ticket = await prisma.ticket.findFirst({
        where: { id, userId },
      });
      if (!ticket) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }
      if (ticket.status === TicketStatus.CLOSED) {
        res.status(400).json({ error: "Ticket is closed" });
        return;
      }

      await prisma.$transaction([
        prisma.ticketMessage.create({
          data: {
            ticketId: id,
            senderId: userId,
            isAdmin: false,
            message,
          },
        }),
        prisma.ticket.update({
          where: { id },
          data: { updatedAt: new Date() },
        }),
      ]);

      const full = await getTicketForUser(prisma, id, userId);
      res.json(mapTicketDetail(full!, "user"));
    } catch (err) {
      next(err);
    }
  }

  async function closeMyTicket(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const id = String(req.params.id ?? "").trim();
      if (!id) {
        res.status(400).json({ error: "Ticket id is required" });
        return;
      }

      const updated = await prisma.ticket.updateMany({
        where: { id, userId, status: TicketStatus.OPEN },
        data: { status: TicketStatus.CLOSED },
      });
      if (updated.count === 0) {
        const exists = await prisma.ticket.findFirst({
          where: { id, userId },
        });
        if (!exists) {
          res.status(404).json({ error: "Ticket not found" });
          return;
        }
        res.status(400).json({ error: "Ticket is already closed" });
        return;
      }

      const full = await getTicketForUser(prisma, id, userId);
      res.json(mapTicketDetail(full!, "user"));
    } catch (err) {
      next(err);
    }
  }

  async function listAllTickets(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const statusParam = String(req.query.status ?? "ALL").toUpperCase();
      const where =
        statusParam === "OPEN" || statusParam === "CLOSED"
          ? { status: statusParam as TicketStatus }
          : {};

      const tickets = await prisma.ticket.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, name: true } },
          messages: {
            select: { isAdmin: true, message: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          _count: { select: { messages: true } },
        },
      });

      const items = sortTicketsForAdmin(
        tickets.map((t) => mapTicketSummary(t, "admin")),
      );

      res.json({ tickets: items });
    } catch (err) {
      next(err);
    }
  }

  async function getAdminTicket(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const id = String(req.params.id ?? "").trim();
      if (!id) {
        res.status(400).json({ error: "Ticket id is required" });
        return;
      }

      const ticket = await getTicketForAdmin(prisma, id);
      if (!ticket) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }

      res.json(mapTicketDetail(ticket, "admin"));
    } catch (err) {
      next(err);
    }
  }

  async function adminReply(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const adminId = req.userId;
      if (!adminId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const role = await prisma.user.findUnique({
        where: { id: adminId },
        select: { role: true },
      });
      if (!role || role.role !== Role.ADMIN) {
        res.status(403).json({ error: "Admin access required" });
        return;
      }

      const id = String(req.params.id ?? "").trim();
      const message = trimMessage((req.body as { message?: unknown }).message);

      if (!id) {
        res.status(400).json({ error: "Ticket id is required" });
        return;
      }
      if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
      }
      if (message.length > MAX_MESSAGE) {
        res.status(400).json({ error: `message must be at most ${MAX_MESSAGE} characters` });
        return;
      }

      const ticket = await prisma.ticket.findUnique({ where: { id } });
      if (!ticket) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }
      if (ticket.status === TicketStatus.CLOSED) {
        res.status(400).json({ error: "Ticket is closed" });
        return;
      }

      await prisma.$transaction([
        prisma.ticketMessage.create({
          data: {
            ticketId: id,
            senderId: adminId,
            isAdmin: true,
            message,
          },
        }),
        prisma.ticket.update({
          where: { id },
          data: { updatedAt: new Date() },
        }),
      ]);

      const full = await getTicketForAdmin(prisma, id);
      res.json(mapTicketDetail(full!, "admin"));
    } catch (err) {
      next(err);
    }
  }

  async function adminCloseTicket(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const id = String(req.params.id ?? "").trim();
      if (!id) {
        res.status(400).json({ error: "Ticket id is required" });
        return;
      }

      const updated = await prisma.ticket.updateMany({
        where: { id, status: TicketStatus.OPEN },
        data: { status: TicketStatus.CLOSED },
      });
      if (updated.count === 0) {
        const exists = await prisma.ticket.findUnique({ where: { id } });
        if (!exists) {
          res.status(404).json({ error: "Ticket not found" });
          return;
        }
        res.status(400).json({ error: "Ticket is already closed" });
        return;
      }

      const full = await getTicketForAdmin(prisma, id);
      res.json(mapTicketDetail(full!, "admin"));
    } catch (err) {
      next(err);
    }
  }

  return {
    createTicket,
    listMyTickets,
    getMyTicket,
    replyToTicket,
    closeMyTicket,
    listAllTickets,
    getAdminTicket,
    adminReply,
    adminCloseTicket,
  };
}
