"use client";

import { useCallback, useState, type ReactNode } from "react";
import {
  CustomEmailModal,
  type CustomEmailRecipient,
} from "./CustomEmailModal";
import { EmailOptionsMenu } from "./EmailOptionsMenu";

export type AdminEmailRecipient = CustomEmailRecipient;

type UseAdminEmailActionsArgs = {
  apiBase: string;
  authHeaders: () => HeadersInit;
  onToast?: (toast: { type: "ok" | "err"; text: string }) => void;
};

/** Shared dropdown + modal state for admin Members/Users tables. */
export function useAdminEmailActions({
  apiBase,
  authHeaders,
  onToast,
}: UseAdminEmailActionsArgs) {
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const [selectedEmailUser, setSelectedEmailUser] =
    useState<AdminEmailRecipient | null>(null);
  const [resendingUserId, setResendingUserId] = useState<string | null>(null);

  const resendWelcomeEmail = useCallback(
    async (user: AdminEmailRecipient) => {
      setOpenDropdownId(null);
      setResendingUserId(user.id);
      try {
        const res = await fetch(`${apiBase}/admin/resend-registration-email`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            userId: user.id,
            templateName: "welcome",
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          throw new Error(body.error ?? "Failed to send welcome email");
        }
        onToast?.({
          type: "ok",
          text: `Welcome email sent to ${user.email}.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Email send failed";
        onToast?.({ type: "err", text: msg });
      } finally {
        setResendingUserId(null);
      }
    },
    [apiBase, authHeaders, onToast],
  );

  const openCustomEmailModal = useCallback((user: AdminEmailRecipient) => {
    setOpenDropdownId(null);
    setSelectedEmailUser(user);
  }, []);

  const closeCustomEmailModal = useCallback(() => {
    setSelectedEmailUser(null);
  }, []);

  function renderEmailOptions(
    user: AdminEmailRecipient,
    sibling?: ReactNode,
  ) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {sibling}
        <EmailOptionsMenu
          rowId={user.id}
          openDropdownId={openDropdownId}
          onOpenDropdown={setOpenDropdownId}
          onResendWelcome={() => void resendWelcomeEmail(user)}
          onSendCustomMessage={() => openCustomEmailModal(user)}
          resending={resendingUserId === user.id}
        />
      </div>
    );
  }

  const emailModal = (
    <CustomEmailModal
      open={selectedEmailUser !== null}
      recipient={selectedEmailUser}
      apiBase={apiBase}
      authHeaders={authHeaders}
      onClose={closeCustomEmailModal}
      onSuccess={(msg) => onToast?.({ type: "ok", text: msg })}
      onError={(msg) => onToast?.({ type: "err", text: msg })}
    />
  );

  return {
    openDropdownId,
    setOpenDropdownId,
    selectedEmailUser,
    resendingUserId,
    resendWelcomeEmail,
    openCustomEmailModal,
    closeCustomEmailModal,
    renderEmailOptions,
    emailModal,
  };
}

/** @deprecated Use useAdminEmailActions + EmailOptionsMenu */
export { EmailOptionsMenu };
