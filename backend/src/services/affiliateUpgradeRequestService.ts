import {
  MemberUpgradeRequestStatus,
  NominatedSalesRole,
  Prisma,
  Role,
  type PrismaClient,
} from "@prisma/client";
import {
  isSalesMemberRole,
  upgradeUserToSalesMember,
  type SalesMemberRole,
} from "./affiliateMemberService.js";

export type NominationUplineOption = {
  id: string;
  name: string | null;
  email: string;
  role: Role;
  label: string;
};

export type PartnerNominationOptions = {
  requesterRole: Role;
  allowedRoles: NominatedSalesRole[];
  uplineOptions: NominationUplineOption[];
  defaultUplineId: string;
  uplineLocked: boolean;
};

export type AdminUpgradeRequestRow = {
  id: string;
  targetUserEmail: string;
  requestedRole: NominatedSalesRole;
  status: MemberUpgradeRequestStatus;
  createdAt: string;
  requester: {
    id: string;
    name: string | null;
    email: string;
    role: Role;
  };
  assignedParent: {
    id: string;
    name: string | null;
    email: string;
    role: Role;
  };
  targetUser: {
    id: string;
    name: string | null;
    email: string;
    role: Role;
  } | null;
};

type ServiceError = { ok: false; status: number; error: string };
type ServiceOk<T> = { ok: true; data: T };

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unexpected error";
}

function mapPrismaError(err: unknown): ServiceError | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return null;
  }

  switch (err.code) {
    case "P2002":
      return {
        ok: false,
        status: 400,
        error: "A pending nomination already exists for this user",
      };
    case "P2003":
      return {
        ok: false,
        status: 400,
        error: "Invalid requester or upline reference",
      };
    case "P2021":
      return {
        ok: false,
        status: 503,
        error:
          "MemberUpgradeRequest table is missing. Run `npx prisma migrate deploy` on the server.",
      };
    case "P2025":
      return { ok: false, status: 404, error: "Record not found" };
    default:
      return {
        ok: false,
        status: 500,
        error: err.message,
      };
  }
}

function uplineLabel(user: {
  name: string | null;
  email: string;
  role: Role;
}): string {
  const name = user.name?.trim();
  const roleLabel =
    user.role === Role.DIRECTOR
      ? "Director"
      : user.role === Role.MANAGER
        ? "Manager"
        : "Executive";
  return name ? `${name} (${roleLabel})` : `${user.email} (${roleLabel})`;
}

export async function getPartnerNominationOptions(
  prisma: PrismaClient,
  requesterId: string,
): Promise<PartnerNominationOptions | null> {
  const requester = await prisma.user.findUnique({
    where: { id: requesterId },
    select: { id: true, name: true, email: true, role: true },
  });

  if (!requester) return null;

  if (requester.role === Role.MANAGER) {
    return {
      requesterRole: requester.role,
      allowedRoles: [NominatedSalesRole.EXECUTIVE],
      uplineOptions: [
        {
          id: requester.id,
          name: requester.name,
          email: requester.email,
          role: requester.role,
          label: uplineLabel(requester),
        },
      ],
      defaultUplineId: requester.id,
      uplineLocked: true,
    };
  }

  if (requester.role === Role.DIRECTOR) {
    const managers = await prisma.user.findMany({
      where: { role: Role.MANAGER, parentId: requester.id },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { email: "asc" },
    });

    const uplineOptions: NominationUplineOption[] = [
      {
        id: requester.id,
        name: requester.name,
        email: requester.email,
        role: requester.role,
        label: `${uplineLabel(requester)} — direct to you`,
      },
      ...managers.map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        role: m.role,
        label: uplineLabel(m),
      })),
    ];

    return {
      requesterRole: requester.role,
      allowedRoles: [NominatedSalesRole.MANAGER, NominatedSalesRole.EXECUTIVE],
      uplineOptions,
      defaultUplineId: requester.id,
      uplineLocked: false,
    };
  }

  return null;
}

async function validateNominationAssignment(
  prisma: PrismaClient,
  requester: { id: string; role: Role },
  requestedRole: NominatedSalesRole,
  assignedParentId: string,
): Promise<ServiceError | ServiceOk<{ assignedParentId: string }>> {
  if (requester.role === Role.MANAGER) {
    if (requestedRole !== NominatedSalesRole.EXECUTIVE) {
      return {
        ok: false,
        status: 403,
        error: "Managers may only nominate users for the Executive role",
      };
    }
    if (assignedParentId !== requester.id) {
      return {
        ok: false,
        status: 400,
        error: "Managers must assign themselves as the upline",
      };
    }
    return { ok: true, data: { assignedParentId: requester.id } };
  }

  if (requester.role === Role.DIRECTOR) {
    if (requestedRole === NominatedSalesRole.MANAGER) {
      if (assignedParentId !== requester.id) {
        return {
          ok: false,
          status: 400,
          error: "Managers must report directly to you",
        };
      }
      return { ok: true, data: { assignedParentId: requester.id } };
    }

    if (requestedRole === NominatedSalesRole.EXECUTIVE) {
      if (assignedParentId === requester.id) {
        return { ok: true, data: { assignedParentId: requester.id } };
      }

      const manager = await prisma.user.findUnique({
        where: { id: assignedParentId },
        select: { id: true, role: true, parentId: true },
      });
      if (
        !manager ||
        manager.role !== Role.MANAGER ||
        manager.parentId !== requester.id
      ) {
        return {
          ok: false,
          status: 400,
          error: "Executive upline must be you or one of your Managers",
        };
      }
      return { ok: true, data: { assignedParentId: manager.id } };
    }
  }

  return {
    ok: false,
    status: 403,
    error: "Only Directors and Managers may submit nominations",
  };
}

export type CreateNominationArgs = {
  targetUserEmail: string;
  requestedRole: NominatedSalesRole;
  assignedParentId: string;
};

export async function createMemberUpgradeRequest(
  prisma: PrismaClient,
  requesterId: string,
  args: CreateNominationArgs,
): Promise<ServiceOk<{ id: string }> | ServiceError> {
  try {
    const email = normalizeEmail(args.targetUserEmail);
    if (!email || !email.includes("@")) {
      return {
        ok: false,
        status: 400,
        error: "A valid target user email is required",
      };
    }

    const requester = await prisma.user.findUnique({
      where: { id: requesterId },
      select: { id: true, role: true, email: true },
    });
    if (!requester) {
      return { ok: false, status: 404, error: "Requester not found" };
    }

    if (requester.role !== Role.MANAGER && requester.role !== Role.DIRECTOR) {
      return {
        ok: false,
        status: 403,
        error: "Only Directors and Managers may submit nominations",
      };
    }

    const roleRaw = args.requestedRole;
    if (
      roleRaw !== NominatedSalesRole.EXECUTIVE &&
      roleRaw !== NominatedSalesRole.MANAGER
    ) {
      return {
        ok: false,
        status: 400,
        error: "requestedRole must be MANAGER or EXECUTIVE",
      };
    }

    const assignedParentId = args.assignedParentId.trim();
    if (!assignedParentId) {
      return { ok: false, status: 400, error: "assignedParentId is required" };
    }

    const assignment = await validateNominationAssignment(
      prisma,
      requester,
      roleRaw,
      assignedParentId,
    );
    if (!assignment.ok) return assignment;

    const target = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, email: true, role: true },
    });
    if (!target) {
      return { ok: false, status: 404, error: "User not found" };
    }
    if (target.role === Role.ADMIN) {
      return { ok: false, status: 400, error: "Admin accounts cannot be nominated" };
    }
    if (isSalesMemberRole(target.role)) {
      return {
        ok: false,
        status: 400,
        error: "User is already a team member",
      };
    }
    if (target.id === requesterId) {
      return { ok: false, status: 400, error: "You cannot nominate yourself" };
    }

    const existingPending = await prisma.memberUpgradeRequest.findFirst({
      where: {
        targetUserEmail: { equals: email, mode: "insensitive" },
        status: MemberUpgradeRequestStatus.PENDING,
      },
      select: { id: true },
    });
    if (existingPending) {
      return {
        ok: false,
        status: 400,
        error: "A pending nomination already exists for this user",
      };
    }

    const parent = await prisma.user.findUnique({
      where: { id: assignment.data.assignedParentId },
      select: { id: true },
    });
    if (!parent) {
      return { ok: false, status: 400, error: "Assigned upline was not found" };
    }

    const row = await prisma.memberUpgradeRequest.create({
      data: {
        targetUserEmail: email,
        requestedRole: roleRaw,
        requesterId,
        assignedParentId: assignment.data.assignedParentId,
        status: MemberUpgradeRequestStatus.PENDING,
      },
      select: { id: true },
    });

    return { ok: true, data: { id: row.id } };
  } catch (err) {
    console.error("[createMemberUpgradeRequest] full error:", err);

    const prismaMapped = mapPrismaError(err);
    if (prismaMapped) {
      return prismaMapped;
    }

    return {
      ok: false,
      status: 500,
      error: errorMessage(err),
    };
  }
}

export async function listPendingMemberUpgradeRequests(
  prisma: PrismaClient,
): Promise<AdminUpgradeRequestRow[]> {
  const rows = await prisma.memberUpgradeRequest.findMany({
    where: { status: MemberUpgradeRequestStatus.PENDING },
    include: {
      requester: {
        select: { id: true, name: true, email: true, role: true },
      },
      assignedParent: {
        select: { id: true, name: true, email: true, role: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const emails = [...new Set(rows.map((r) => r.targetUserEmail))];
  const targets =
    emails.length > 0
      ? await prisma.user.findMany({
          where: {
            OR: emails.map((e) => ({
              email: { equals: e, mode: "insensitive" as const },
            })),
          },
          select: { id: true, name: true, email: true, role: true },
        })
      : [];
  const targetByEmail = new Map(
    targets.map((t) => [t.email.toLowerCase(), t]),
  );

  return rows.map((row) => ({
    id: row.id,
    targetUserEmail: row.targetUserEmail,
    requestedRole: row.requestedRole,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    requester: row.requester,
    assignedParent: row.assignedParent,
    targetUser: targetByEmail.get(row.targetUserEmail.toLowerCase()) ?? null,
  }));
}

export async function rejectMemberUpgradeRequest(
  prisma: PrismaClient,
  requestId: string,
): Promise<ServiceOk<{ id: string }> | ServiceError> {
  const row = await prisma.memberUpgradeRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true },
  });
  if (!row) {
    return { ok: false, status: 404, error: "Nomination request not found" };
  }
  if (row.status !== MemberUpgradeRequestStatus.PENDING) {
    return {
      ok: false,
      status: 409,
      error: "Only pending requests can be rejected",
    };
  }

  await prisma.memberUpgradeRequest.update({
    where: { id: requestId },
    data: { status: MemberUpgradeRequestStatus.REJECTED },
  });

  return { ok: true, data: { id: requestId } };
}

export async function approveMemberUpgradeRequest(
  prisma: PrismaClient,
  requestId: string,
  adminUserId: string,
): Promise<ServiceOk<{ userId: string; role: SalesMemberRole }> | ServiceError> {
  const row = await prisma.memberUpgradeRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      targetUserEmail: true,
      requestedRole: true,
      assignedParentId: true,
    },
  });

  if (!row) {
    return { ok: false, status: 404, error: "Nomination request not found" };
  }
  if (row.status !== MemberUpgradeRequestStatus.PENDING) {
    return {
      ok: false,
      status: 409,
      error: "Only pending requests can be approved",
    };
  }

  const target = await prisma.user.findFirst({
    where: { email: { equals: row.targetUserEmail, mode: "insensitive" } },
    select: { id: true, role: true },
  });
  if (!target) {
    return {
      ok: false,
      status: 404,
      error: "Target user no longer exists",
    };
  }
  if (isSalesMemberRole(target.role)) {
    return {
      ok: false,
      status: 409,
      error: "User is already a team member",
    };
  }

  const newRole =
    row.requestedRole === NominatedSalesRole.MANAGER
      ? Role.MANAGER
      : Role.EXECUTIVE;

  const upgrade = await upgradeUserToSalesMember(prisma, {
    userId: target.id,
    newRole: newRole as SalesMemberRole,
    parentId: row.assignedParentId,
    adminUserId,
  });

  if (!upgrade.ok) {
    return { ok: false, status: upgrade.status, error: upgrade.error };
  }

  await prisma.memberUpgradeRequest.update({
    where: { id: requestId },
    data: { status: MemberUpgradeRequestStatus.APPROVED },
  });

  return {
    ok: true,
    data: { userId: target.id, role: newRole as SalesMemberRole },
  };
}
