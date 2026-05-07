"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type DownloadFileRow = {
  id: string;
  fileName: string;
  filePath: string;
  fileType: string;
  status: string;
  createdAt: string;
};

export default function AdminDownloadsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rows, setRows] = useState<DownloadFileRow[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const authHeaders = useMemo(() => {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    return { Authorization: `Bearer ${token ?? ""}` };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/downloads`, { headers: authHeaders });
      if (!res.ok) {
        throw new Error(`Failed to load downloads (${res.status})`);
      }
      const body = (await res.json()) as { downloads?: DownloadFileRow[] };
      setRows(Array.isArray(body.downloads) ? body.downloads : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load downloads.");
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  async function deleteFile(id: string): Promise<void> {
    const ok = window.confirm(
      "Delete this file permanently from server and records?",
    );
    if (!ok) return;
    setDeletingId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API_BASE}/admin/downloads/${id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (!res.ok) {
        throw new Error(`Delete failed (${res.status})`);
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
      setNotice("Download file deleted successfully.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete file.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-white">Downloads</h1>
        <p className="mt-1 text-sm text-white/55">
          Manage generated exports and backup files.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {notice}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-glassBorder bg-white/[0.02]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.03] text-white/70">
              <tr>
                <th className="px-3 py-2 font-medium">File Name</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-white/45">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-white/45">
                    No generated files available.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-b border-white/[0.06] last:border-0">
                    <td className="px-3 py-2 text-white">{r.fileName}</td>
                    <td className="px-3 py-2 text-white/80">{r.fileType}</td>
                    <td className="px-3 py-2 text-white/60">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <a
                          href={`${API_BASE}${r.filePath}`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md border border-cyan-500/45 bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-500/25"
                        >
                          Download
                        </a>
                        <button
                          type="button"
                          onClick={() => void deleteFile(r.id)}
                          disabled={deletingId === r.id}
                          className="inline-flex items-center gap-1 rounded-md border border-red-500/45 bg-red-500/15 px-3 py-1.5 text-xs font-medium text-red-200 transition hover:bg-red-500/25 disabled:opacity-60"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {deletingId === r.id ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

