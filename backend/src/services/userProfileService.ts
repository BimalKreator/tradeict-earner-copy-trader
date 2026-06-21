import type { Prisma, PrismaClient } from "@prisma/client";

/** Fields users/admins may update via profile endpoints. */
export const PROFILE_UPDATE_FIELDS = [
  "name",
  "mobile",
  "dob",
  "guardianName",
  "gender",
  "address",
  "city",
  "state",
  "pinCode",
  "aadharNumber",
  "panNumber",
  "bankName",
  "bankAccountNumber",
  "bankIfsc",
  "upiId",
  "nomineeName",
  "nomineeRelationship",
  "nomineeMobile",
] as const;

export type ProfileUpdateField = (typeof PROFILE_UPDATE_FIELDS)[number];

export type ProfileUpdateInput = Partial<
  Record<ProfileUpdateField, string | null>
> & {
  dob?: string | null;
};

export const USER_PROFILE_SELECT = {
  id: true,
  email: true,
  name: true,
  mobile: true,
  dob: true,
  guardianName: true,
  gender: true,
  address: true,
  city: true,
  state: true,
  pinCode: true,
  aadharNumber: true,
  panNumber: true,
  bankName: true,
  bankAccountNumber: true,
  bankIfsc: true,
  upiId: true,
  nomineeName: true,
  nomineeRelationship: true,
  nomineeMobile: true,
  acquiredById: true,
  parentId: true,
  acquiredBy: {
    select: {
      id: true,
      name: true,
      email: true,
      affiliateProfile: { select: { referralCode: true } },
    },
  },
  parent: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
    },
  },
} as const;

const GENDER_VALUES = new Set(["Male", "Female", "Other"]);

function parseOptionalString(
  value: unknown,
  field: string,
): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: `${field} must be a string or null` };
  }
  const trimmed = value.trim();
  return { ok: true, value: trimmed.length ? trimmed : null };
}

function parseDob(
  value: unknown,
): { ok: true; value: Date | null | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: "dob must be an ISO date string or null" };
  }
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) {
    return { ok: false, error: "dob is not a valid date" };
  }
  return { ok: true, value: d };
}

function normalizePan(value: string): string {
  return value.toUpperCase().replace(/\s+/g, "");
}

function normalizeAadhar(value: string): string {
  return value.replace(/\D/g, "");
}

function normalizeIfsc(value: string): string {
  return value.toUpperCase().replace(/\s+/g, "");
}

export function parseProfileUpdateBody(
  body: Record<string, unknown>,
): { ok: true; data: Prisma.UserUpdateInput } | { ok: false; error: string } {
  const data: Prisma.UserUpdateInput = {};
  let touched = false;

  for (const field of PROFILE_UPDATE_FIELDS) {
    if (!(field in body)) continue;

    if (field === "dob") {
      const parsed = parseDob(body.dob);
      if (!parsed.ok) return parsed;
      if (parsed.value !== undefined) {
        data.dob = parsed.value;
        touched = true;
      }
      continue;
    }

    const parsed = parseOptionalString(body[field], field);
    if (!parsed.ok) return parsed;
    if (parsed.value === undefined) continue;

    if (field === "gender" && parsed.value !== null && !GENDER_VALUES.has(parsed.value)) {
      return { ok: false, error: "gender must be Male, Female, or Other" };
    }

    if (field === "panNumber" && parsed.value !== null) {
      const pan = normalizePan(parsed.value);
      if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
        return { ok: false, error: "panNumber format is invalid" };
      }
      (data as Record<string, unknown>)[field] = pan;
      touched = true;
      continue;
    }

    if (field === "aadharNumber" && parsed.value !== null) {
      const aadhar = normalizeAadhar(parsed.value);
      if (!/^\d{12}$/.test(aadhar)) {
        return { ok: false, error: "aadharNumber must be 12 digits" };
      }
      (data as Record<string, unknown>)[field] = aadhar;
      touched = true;
      continue;
    }

    if (field === "pinCode" && parsed.value !== null) {
      const pin = parsed.value.replace(/\D/g, "");
      if (!/^\d{6}$/.test(pin)) {
        return { ok: false, error: "pinCode must be 6 digits" };
      }
      (data as Record<string, unknown>)[field] = pin;
      touched = true;
      continue;
    }

    if (field === "bankIfsc" && parsed.value !== null) {
      const ifsc = normalizeIfsc(parsed.value);
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
        return { ok: false, error: "bankIfsc format is invalid" };
      }
      (data as Record<string, unknown>)[field] = ifsc;
      touched = true;
      continue;
    }

    if (field === "mobile" && parsed.value !== null) {
      const mobile = parsed.value.replace(/\D/g, "");
      if (mobile.length < 10 || mobile.length > 15) {
        return { ok: false, error: "mobile must be 10–15 digits" };
      }
      (data as Record<string, unknown>)[field] = mobile;
      touched = true;
      continue;
    }

    if (field === "nomineeMobile" && parsed.value !== null) {
      const mobile = parsed.value.replace(/\D/g, "");
      if (mobile.length < 10 || mobile.length > 15) {
        return { ok: false, error: "nomineeMobile must be 10–15 digits" };
      }
      (data as Record<string, unknown>)[field] = mobile;
      touched = true;
      continue;
    }

    (data as Record<string, unknown>)[field] = parsed.value;
    touched = true;
  }

  if (!touched) {
    return { ok: false, error: "Provide at least one profile field to update" };
  }

  return { ok: true, data };
}

export function formatProfileResponse(
  user: {
    id: string;
    email: string;
    name: string | null;
    mobile: string | null;
    dob: Date | null;
    guardianName: string | null;
    gender: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    pinCode: string | null;
    aadharNumber: string | null;
    panNumber: string | null;
    bankName: string | null;
    bankAccountNumber: string | null;
    bankIfsc: string | null;
    upiId: string | null;
    nomineeName: string | null;
    nomineeRelationship: string | null;
    nomineeMobile: string | null;
    acquiredById: string | null;
    parentId: string | null;
    acquiredBy: {
      id: string;
      name: string | null;
      email: string;
      affiliateProfile: { referralCode: string } | null;
    } | null;
    parent: {
      id: string;
      name: string | null;
      email: string;
      role: string;
    } | null;
  },
) {
  const referrer =
    user.acquiredById && user.acquiredBy
      ? {
          id: user.acquiredBy.id,
          name: user.acquiredBy.name,
          email: user.acquiredBy.email,
          referralCode: user.acquiredBy.affiliateProfile?.referralCode ?? null,
        }
      : null;

  const upline = user.parentId && user.parent
    ? {
        id: user.parent.id,
        name: user.parent.name,
        email: user.parent.email,
        role: user.parent.role,
      }
    : null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    mobile: user.mobile,
    dob: user.dob ? user.dob.toISOString().slice(0, 10) : null,
    guardianName: user.guardianName,
    gender: user.gender,
    address: user.address,
    city: user.city,
    state: user.state,
    pinCode: user.pinCode,
    aadharNumber: user.aadharNumber,
    panNumber: user.panNumber,
    bankName: user.bankName,
    bankAccountNumber: user.bankAccountNumber,
    bankIfsc: user.bankIfsc,
    upiId: user.upiId,
    nomineeName: user.nomineeName,
    nomineeRelationship: user.nomineeRelationship,
    nomineeMobile: user.nomineeMobile,
    referrer,
    upline,
  };
}

export async function updateUserProfileRecord(
  prisma: PrismaClient,
  userId: string,
  data: Prisma.UserUpdateInput,
) {
  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: USER_PROFILE_SELECT,
    });
    return { ok: true as const, user };
  } catch (err: unknown) {
    const code =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      typeof (err as { code: unknown }).code === "string"
        ? (err as { code: string }).code
        : "";
    if (code === "P2002") {
      return {
        ok: false as const,
        error: "PAN or Aadhar number is already registered to another account",
      };
    }
    throw err;
  }
}

export async function fetchUserProfileRecord(prisma: PrismaClient, userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: USER_PROFILE_SELECT,
  });
}
