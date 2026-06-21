export type ProfileReferrer = {
  id: string;
  name: string | null;
  email: string;
  referralCode: string | null;
} | null;

export type ProfileUpline = {
  id: string;
  name: string | null;
  email: string;
  role: string;
} | null;

export type UserProfileData = {
  id: string;
  email: string;
  name: string | null;
  mobile: string | null;
  dob: string | null;
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
  referrer: ProfileReferrer;
  upline: ProfileUpline;
};

export type ProfileFormValues = {
  name: string;
  mobile: string;
  dob: string;
  guardianName: string;
  gender: string;
  address: string;
  city: string;
  state: string;
  pinCode: string;
  aadharNumber: string;
  panNumber: string;
  bankName: string;
  bankAccountNumber: string;
  bankIfsc: string;
  upiId: string;
  nomineeName: string;
  nomineeRelationship: string;
  nomineeMobile: string;
};

export function emptyProfileFormValues(
  profile?: Partial<UserProfileData> | null,
): ProfileFormValues {
  return {
    name: profile?.name ?? "",
    mobile: profile?.mobile ?? "",
    dob: profile?.dob ?? "",
    guardianName: profile?.guardianName ?? "",
    gender: profile?.gender ?? "",
    address: profile?.address ?? "",
    city: profile?.city ?? "",
    state: profile?.state ?? "",
    pinCode: profile?.pinCode ?? "",
    aadharNumber: profile?.aadharNumber ?? "",
    panNumber: profile?.panNumber ?? "",
    bankName: profile?.bankName ?? "",
    bankAccountNumber: profile?.bankAccountNumber ?? "",
    bankIfsc: profile?.bankIfsc ?? "",
    upiId: profile?.upiId ?? "",
    nomineeName: profile?.nomineeName ?? "",
    nomineeRelationship: profile?.nomineeRelationship ?? "",
    nomineeMobile: profile?.nomineeMobile ?? "",
  };
}

export function profileFormValuesToPayload(values: ProfileFormValues) {
  const str = (v: string) => {
    const t = v.trim();
    return t.length ? t : null;
  };
  return {
    name: str(values.name),
    mobile: str(values.mobile),
    dob: str(values.dob),
    guardianName: str(values.guardianName),
    gender: str(values.gender),
    address: str(values.address),
    city: str(values.city),
    state: str(values.state),
    pinCode: str(values.pinCode),
    aadharNumber: str(values.aadharNumber),
    panNumber: str(values.panNumber),
    bankName: str(values.bankName),
    bankAccountNumber: str(values.bankAccountNumber),
    bankIfsc: str(values.bankIfsc),
    upiId: str(values.upiId),
    nomineeName: str(values.nomineeName),
    nomineeRelationship: str(values.nomineeRelationship),
    nomineeMobile: str(values.nomineeMobile),
  };
}

const inputClass =
  "mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none ring-primary/25 placeholder:text-white/30 focus:ring-2 disabled:opacity-60";
const labelClass = "text-xs font-medium text-white/60";
const sectionClass =
  "space-y-4 rounded-xl border border-white/[0.08] bg-black/20 p-5 md:p-6";

export type UserProfileFormProps = {
  email: string;
  values: ProfileFormValues;
  onChange: (values: ProfileFormValues) => void;
  referrer: ProfileReferrer;
  upline: ProfileUpline;
  saving?: boolean;
  formId?: string;
  showReferralSection?: boolean;
};

export function UserProfileForm({
  email,
  values,
  onChange,
  referrer,
  upline,
  saving = false,
  formId = "user-profile-form",
  showReferralSection = true,
}: UserProfileFormProps) {
  function set<K extends keyof ProfileFormValues>(key: K, value: ProfileFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  return (
    <div className="space-y-8">
      <section className={sectionClass}>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/45">
          Personal Information
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2 rounded-lg border border-white/[0.08] bg-black/25 px-4 py-3">
            <p className={labelClass}>Email</p>
            <p className="mt-1 text-sm text-white/85">{email}</p>
          </div>
          <label className="block sm:col-span-2">
            <span className={labelClass}>Full name</span>
            <input
              type="text"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              disabled={saving}
              className={inputClass}
              placeholder="Your full name"
            />
          </label>
          <label className="block">
            <span className={labelClass}>Mobile</span>
            <input
              type="tel"
              value={values.mobile}
              onChange={(e) => set("mobile", e.target.value)}
              disabled={saving}
              className={inputClass}
              placeholder="10-digit mobile"
            />
          </label>
          <label className="block">
            <span className={labelClass}>Date of birth</span>
            <input
              type="date"
              value={values.dob}
              onChange={(e) => set("dob", e.target.value)}
              disabled={saving}
              className={inputClass}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className={labelClass}>Father&apos;s / Husband&apos;s name</span>
            <input
              type="text"
              value={values.guardianName}
              onChange={(e) => set("guardianName", e.target.value)}
              disabled={saving}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Gender</span>
            <select
              value={values.gender}
              onChange={(e) => set("gender", e.target.value)}
              disabled={saving}
              className={inputClass}
            >
              <option value="">Select…</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className={labelClass}>Address</span>
            <textarea
              value={values.address}
              onChange={(e) => set("address", e.target.value)}
              disabled={saving}
              rows={2}
              className={`${inputClass} resize-y`}
              placeholder="Street address"
            />
          </label>
          <label className="block">
            <span className={labelClass}>City</span>
            <input
              type="text"
              value={values.city}
              onChange={(e) => set("city", e.target.value)}
              disabled={saving}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>State</span>
            <input
              type="text"
              value={values.state}
              onChange={(e) => set("state", e.target.value)}
              disabled={saving}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>PIN code</span>
            <input
              type="text"
              value={values.pinCode}
              onChange={(e) => set("pinCode", e.target.value)}
              disabled={saving}
              className={inputClass}
              placeholder="6 digits"
            />
          </label>
        </div>
      </section>

      <section className={sectionClass}>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/45">
          Identity Details
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelClass}>Aadhar number</span>
            <input
              type="text"
              value={values.aadharNumber}
              onChange={(e) => set("aadharNumber", e.target.value)}
              disabled={saving}
              className={inputClass}
              placeholder="12 digits"
            />
          </label>
          <label className="block">
            <span className={labelClass}>PAN number</span>
            <input
              type="text"
              value={values.panNumber}
              onChange={(e) => set("panNumber", e.target.value.toUpperCase())}
              disabled={saving}
              className={inputClass}
              placeholder="ABCDE1234F"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className={labelClass}>Bank name</span>
            <input
              type="text"
              value={values.bankName}
              onChange={(e) => set("bankName", e.target.value)}
              disabled={saving}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Bank account number</span>
            <input
              type="text"
              value={values.bankAccountNumber}
              onChange={(e) => set("bankAccountNumber", e.target.value)}
              disabled={saving}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>IFSC code</span>
            <input
              type="text"
              value={values.bankIfsc}
              onChange={(e) => set("bankIfsc", e.target.value.toUpperCase())}
              disabled={saving}
              className={inputClass}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className={labelClass}>UPI ID</span>
            <input
              type="text"
              value={values.upiId}
              onChange={(e) => set("upiId", e.target.value)}
              disabled={saving}
              className={inputClass}
              placeholder="name@upi"
            />
          </label>
        </div>
      </section>

      <section className={sectionClass}>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/45">
          Nominee Details
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className={labelClass}>Nominee name</span>
            <input
              type="text"
              value={values.nomineeName}
              onChange={(e) => set("nomineeName", e.target.value)}
              disabled={saving}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Relationship</span>
            <input
              type="text"
              value={values.nomineeRelationship}
              onChange={(e) => set("nomineeRelationship", e.target.value)}
              disabled={saving}
              className={inputClass}
              placeholder="Spouse, Parent, etc."
            />
          </label>
          <label className="block">
            <span className={labelClass}>Nominee mobile</span>
            <input
              type="tel"
              value={values.nomineeMobile}
              onChange={(e) => set("nomineeMobile", e.target.value)}
              disabled={saving}
              className={inputClass}
            />
          </label>
        </div>
      </section>

      {showReferralSection ? (
        <section className={sectionClass}>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/45">
            Referral Information
          </h2>
          <p className="text-xs text-white/45">
            Referring member details are read-only and managed by the platform.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-white/[0.08] bg-black/25 px-4 py-3">
              <p className={labelClass}>Referring member</p>
              <p className="mt-1 text-sm font-medium text-white">
                {referrer?.name?.trim() || referrer?.email || "—"}
              </p>
              {referrer?.referralCode ? (
                <p className="mt-1 font-mono text-xs text-primary/90">
                  Code: {referrer.referralCode}
                </p>
              ) : null}
              {referrer?.id ? (
                <p className="mt-1 text-xs text-white/40">ID: {referrer.id}</p>
              ) : null}
            </div>
            <div className="rounded-lg border border-white/[0.08] bg-black/25 px-4 py-3">
              <p className={labelClass}>Upline member</p>
              <p className="mt-1 text-sm font-medium text-white">
                {upline?.name?.trim() || upline?.email || "—"}
              </p>
              {upline?.role ? (
                <p className="mt-1 text-xs text-white/40">Role: {upline.role}</p>
              ) : null}
              {upline?.id ? (
                <p className="mt-1 text-xs text-white/40">ID: {upline.id}</p>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <div className="flex justify-end">
        <button
          type="submit"
          form={formId}
          disabled={saving}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white shadow-lg shadow-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>
    </div>
  );
}
