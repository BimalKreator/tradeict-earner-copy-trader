"use client";

import { useCallback, useState } from "react";
import type { EmailManagerRecipient } from "./EmailManagerModal";

export type AdminEmailRecipient = EmailManagerRecipient;

type UseAdminEmailActionsArgs = {
  onToast?: (toast: { type: "ok" | "err"; text: string }) => void;
};

/** Shared email manager modal state for admin Members/Users tables. */
export function useAdminEmailActions(_args: UseAdminEmailActionsArgs = {}) {
  const [emailManagerUser, setEmailManagerUser] =
    useState<AdminEmailRecipient | null>(null);

  const openEmailManager = useCallback((user: AdminEmailRecipient) => {
    setEmailManagerUser(user);
  }, []);

  const closeEmailManager = useCallback(() => {
    setEmailManagerUser(null);
  }, []);

  return {
    emailManagerUser,
    isEmailManagerOpen: emailManagerUser !== null,
    openEmailManager,
    closeEmailManager,
  };
}
