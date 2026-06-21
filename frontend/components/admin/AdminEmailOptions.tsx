"use client";

import { useCallback, useState } from "react";
import {
  EmailManagerModal,
  type EmailManagerRecipient,
} from "./EmailManagerModal";

export type AdminEmailRecipient = EmailManagerRecipient;

type UseAdminEmailActionsArgs = {
  apiBase: string;
  authHeaders: () => HeadersInit;
  onToast?: (toast: { type: "ok" | "err"; text: string }) => void;
};

/** Shared email manager modal state for admin Members/Users tables. */
export function useAdminEmailActions({
  apiBase,
  authHeaders,
  onToast,
}: UseAdminEmailActionsArgs) {
  const [emailManagerUser, setEmailManagerUser] =
    useState<AdminEmailRecipient | null>(null);

  const openEmailManager = useCallback((user: AdminEmailRecipient) => {
    setEmailManagerUser(user);
  }, []);

  const closeEmailManager = useCallback(() => {
    setEmailManagerUser(null);
  }, []);

  const emailManagerModal = (
    <EmailManagerModal
      open={emailManagerUser !== null}
      recipient={emailManagerUser}
      apiBase={apiBase}
      authHeaders={authHeaders}
      onClose={closeEmailManager}
      onToast={onToast}
    />
  );

  return {
    emailManagerUser,
    openEmailManager,
    closeEmailManager,
    emailManagerModal,
  };
}
