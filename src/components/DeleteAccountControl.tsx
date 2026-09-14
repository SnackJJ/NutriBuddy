"use client";

import { useCallback, useState } from "react";

/**
 * Delete-account control (S5 / #121).
 *
 * Deletion is irreversible, so the confirmation is a typed word rather than a
 * second button: a click-through dialog is dismissed by reflex, and the user
 * cannot tell afterwards whether they meant it. The copy says what goes and what
 * stays — the account and everything scoped to it, while the shared food catalog
 * and evidence corpus are not the user's data and cannot be deleted by them.
 *
 * The response's `clean` flag is surfaced instead of hidden: if the server reports
 * that rows survived the cascade, the user is told to contact the operator rather
 * than shown "done" over data that is still there.
 */

/** The word that has to be typed. Exported so the copy and the check cannot drift. */
export const DELETE_CONFIRMATION_WORD = "DELETE";

export interface DeleteAccountControlProps {
  /** Sends the authenticated DELETE; rejects or returns an error string on failure. */
  readonly onDelete: () => Promise<{ readonly clean: boolean } | string>;
  readonly email: string;
}

export function DeleteAccountControl({ onDelete, email }: DeleteAccountControlProps) {
  const [expanded, setExpanded] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const confirmed = typed.trim().toUpperCase() === DELETE_CONFIRMATION_WORD;

  const submit = useCallback(async () => {
    if (!confirmed) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await onDelete();
      if (typeof result === "string") {
        setOutcome(result);
        setBusy(false);
        return;
      }
      if (!result.clean) {
        setOutcome(
          "The account was deleted, but some records could not be confirmed as removed. Please tell the operator.",
        );
        setBusy(false);
        return;
      }
      // The session is gone with the account; the page reloads into the signed-out
      // state rather than rendering a stale form for a user that no longer exists.
      window.location.href = "/";
    } catch (err) {
      setOutcome(err instanceof Error ? err.message : "Deletion failed.");
      setBusy(false);
    }
  }, [confirmed, onDelete]);

  return (
    <section
      className="mt-12 rounded-lg border border-red-200 bg-red-50/50 p-4"
      data-account-deletion
    >
      <h2 className="text-sm font-semibold text-red-900">Delete account</h2>
      <p className="mt-1 text-xs leading-relaxed text-red-900/80">
        This removes <strong>{email}</strong> and everything recorded under it: your profile
        (allergies, medications, targets), meal logs, proposals and the turn traces.
        It cannot be undone. The shared food catalog and evidence corpus are not your
        data and are not affected.
      </p>

      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
        >
          Delete my account…
        </button>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-xs text-red-900" htmlFor="delete-confirmation">
            Type {DELETE_CONFIRMATION_WORD} to confirm
          </label>
          <input
            id="delete-confirmation"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            className="w-40 rounded-md border border-red-300 px-2 py-1 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!confirmed || busy}
              onClick={() => void submit()}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Deleting…" : "Delete permanently"}
            </button>
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                setTyped("");
                setOutcome(null);
              }}
              className="rounded-md px-3 py-1.5 text-xs text-red-900 underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {outcome && (
        <p className="mt-2 text-xs text-red-900" role="alert">
          {outcome}
        </p>
      )}
    </section>
  );
}
