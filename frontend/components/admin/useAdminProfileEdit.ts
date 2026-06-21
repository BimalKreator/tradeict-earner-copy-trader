"use client";

import { useCallback, useState } from "react";

export type AdminProfileTarget = {
  id: string;
  email: string;
  name: string | null;
};

/** Shared admin profile edit modal state for Members/Users tables. */
export function useAdminProfileEdit() {
  const [profileEditUser, setProfileEditUser] = useState<AdminProfileTarget | null>(
    null,
  );

  const openProfileEdit = useCallback((user: AdminProfileTarget) => {
    setProfileEditUser(user);
  }, []);

  const closeProfileEdit = useCallback(() => {
    setProfileEditUser(null);
  }, []);

  return {
    profileEditUser,
    isProfileEditOpen: profileEditUser !== null,
    openProfileEdit,
    closeProfileEdit,
  };
}
