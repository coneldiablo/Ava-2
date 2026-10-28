import { useState } from "react";
import { KeyRound, X } from "lucide-react";
import { useAuth } from "@/auth/AuthContext";
import { Card, PillButton } from "@/components/ui/core";

export function ChangePasswordModal({ isOpen, onClose, mandatory = false }) {
  const { changePassword } = useAuth();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  if (!isOpen) {
    return null;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      return;
    }
    if (newPassword.length < 5) {
      setError("Password must be at least 5 characters.");
      return;
    }

    setLoading(true);
    try {
      await changePassword(oldPassword, newPassword);
      setSuccess("Password updated successfully.");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      if (!mandatory) {
        setTimeout(() => onClose?.(), 800);
      }
    } catch (err) {
      setError(err?.response?.data?.detail || "Failed to update password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#111111]/55 p-4 backdrop-blur-sm">
      <Card className="w-full max-w-lg border-[#111111] bg-[#f2f2f2] p-0">
        <div className="border-b border-[#111111]/10 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#111111] text-white">
                <KeyRound size={18} />
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-[#838282]">
                  Account Security
                </p>
                <h2 className="font-clash-display text-3xl font-bold uppercase">
                  Change Password
                </h2>
              </div>
            </div>
            {!mandatory ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded-full p-2 text-[#838282] transition-colors hover:bg-[#111111]/5 hover:text-[#111111]"
              >
                <X size={18} />
              </button>
            ) : null}
          </div>
        </div>

        <form className="space-y-5 p-6" onSubmit={handleSubmit}>
          {mandatory ? (
            <div className="border border-amber-400/40 bg-amber-100/80 p-4 text-sm">
              You must change the default password before continuing.
            </div>
          ) : null}

          {error ? (
            <div className="border border-red-400/40 bg-red-100/80 p-4 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          {success ? (
            <div className="border border-emerald-400/40 bg-emerald-100/80 p-4 text-sm text-emerald-700">
              {success}
            </div>
          ) : null}

          <Field
            label="Current Password"
            value={oldPassword}
            onChange={setOldPassword}
            type="password"
          />
          <Field
            label="New Password"
            value={newPassword}
            onChange={setNewPassword}
            type="password"
          />
          <Field
            label="Confirm Password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            type="password"
          />

          <div className="flex justify-end gap-3 pt-2">
            {!mandatory ? (
              <PillButton type="button" onClick={onClose}>
                Cancel
              </PillButton>
            ) : null}
            <PillButton type="submit" variant="solid" disabled={loading}>
              {loading ? "Updating..." : "Update Password"}
            </PillButton>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }) {
  return (
    <label className="block space-y-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none transition-all focus:border-[#111111]"
      />
    </label>
  );
}
