import {
  Role,
  TicketStatus,
  type Prisma,
  type PrismaClient,
  type Ticket,
  type TicketMessage,
} from "@prisma/client";

export type TicketMessageDto = {
  id: string;
  ticketId: string;
  senderId: string;
  senderName: string | null;
  senderEmail: string;
  isAdmin: boolean;
  message: string;
  createdAt: string;
};

export type TicketSummaryDto = {
  id: string;
  userId: string;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageIsAdmin: boolean | null;
  unread: boolean;
  userEmail?: string;
  userName?: string | null;
};

type MessageWithSender = TicketMessage & {
  sender: { id: string; email: string; name: string | null };
};

type TicketWithRelations = Ticket & {
  user?: { id: string; email: string; name: string | null };
  messages: MessageWithSender[];
};

const MESSAGE_INCLUDE = {
  sender: { select: { id: true, email: true, name: true } },
} satisfies Prisma.TicketMessageInclude;

export function isUnreadForAdmin(
  status: TicketStatus,
  lastMessage: { isAdmin: boolean } | null,
): boolean {
  return (
    status === TicketStatus.OPEN &&
    lastMessage !== null &&
    !lastMessage.isAdmin
  );
}

export function isUnreadForUser(
  status: TicketStatus,
  lastMessage: { isAdmin: boolean } | null,
): boolean {
  return (
    status === TicketStatus.OPEN &&
    lastMessage !== null &&
    lastMessage.isAdmin
  );
}

function previewMessage(text: string, max = 120): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function mapMessage(row: MessageWithSender): TicketMessageDto {
  return {
    id: row.id,
    ticketId: row.ticketId,
    senderId: row.senderId,
    senderName: row.sender.name,
    senderEmail: row.sender.email,
    isAdmin: row.isAdmin,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapTicketSummary(
  ticket: Ticket & {
    user?: { id: string; email: string; name: string | null };
    messages: { isAdmin: boolean; message: string; createdAt: Date }[];
    _count?: { messages: number };
  },
  viewer: "user" | "admin",
): TicketSummaryDto {
  const sorted = [...ticket.messages].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const last = sorted[0] ?? null;
  const messageCount = ticket._count?.messages ?? ticket.messages.length;

  const unread =
    viewer === "admin"
      ? isUnreadForAdmin(ticket.status, last)
      : isUnreadForUser(ticket.status, last);

  return {
    id: ticket.id,
    userId: ticket.userId,
    subject: ticket.subject,
    status: ticket.status,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    messageCount,
    lastMessageAt: last ? last.createdAt.toISOString() : null,
    lastMessagePreview: last ? previewMessage(last.message) : null,
    lastMessageIsAdmin: last ? last.isAdmin : null,
    unread,
    ...(ticket.user
      ? { userEmail: ticket.user.email, userName: ticket.user.name }
      : {}),
  };
}

export function sortTicketsForAdmin(
  items: TicketSummaryDto[],
): TicketSummaryDto[] {
  return [...items].sort((a, b) => {
    const rank = (t: TicketSummaryDto) => {
      if (t.status === TicketStatus.OPEN && t.unread) return 0;
      if (t.status === TicketStatus.OPEN) return 1;
      return 2;
    };
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const ta = new Date(a.updatedAt).getTime();
    const tb = new Date(b.updatedAt).getTime();
    return tb - ta;
  });
}

export async function getTicketForUser(
  prisma: PrismaClient,
  ticketId: string,
  userId: string,
): Promise<TicketWithRelations | null> {
  return prisma.ticket.findFirst({
    where: { id: ticketId, userId },
    include: {
      user: { select: { id: true, email: true, name: true } },
      messages: { include: MESSAGE_INCLUDE, orderBy: { createdAt: "asc" } },
    },
  });
}

export async function getTicketForAdmin(
  prisma: PrismaClient,
  ticketId: string,
): Promise<TicketWithRelations | null> {
  return prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      user: { select: { id: true, email: true, name: true } },
      messages: { include: MESSAGE_INCLUDE, orderBy: { createdAt: "asc" } },
    },
  });
}

export function mapTicketDetail(
  ticket: TicketWithRelations,
  viewer: "user" | "admin",
) {
  const summary = mapTicketSummary(
    {
      ...ticket,
      messages: ticket.messages.map((m) => ({
        isAdmin: m.isAdmin,
        message: m.message,
        createdAt: m.createdAt,
      })),
      _count: { messages: ticket.messages.length },
    },
    viewer,
  );
  return {
    ticket: summary,
    messages: ticket.messages.map(mapMessage),
  };
}

export async function assertTicketOpen(
  prisma: PrismaClient,
  ticketId: string,
): Promise<Ticket | null> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return null;
  if (ticket.status === TicketStatus.CLOSED) {
    return ticket;
  }
  return ticket;
}

export async function getUserRole(
  prisma: PrismaClient,
  userId: string,
): Promise<Role | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  return user?.role ?? null;
}
