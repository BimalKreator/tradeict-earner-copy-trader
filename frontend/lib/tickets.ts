export type TicketStatus = "OPEN" | "CLOSED";

export type TicketSummary = {
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

export type TicketMessage = {
  id: string;
  ticketId: string;
  senderId: string;
  senderName: string | null;
  senderEmail: string;
  isAdmin: boolean;
  message: string;
  createdAt: string;
};

export type TicketDetailResponse = {
  ticket: TicketSummary;
  messages: TicketMessage[];
};

export function statusBadgeClass(status: TicketStatus): string {
  return status === "OPEN"
    ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
    : "bg-slate-500/15 text-slate-300 ring-1 ring-slate-500/30";
}

export function formatTicketDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
