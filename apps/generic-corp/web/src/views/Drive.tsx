import { useRef, useState } from "preact/hooks";

import { api, type DriveEntry, fileUrl } from "../api.js";
import { Empty, ErrorNote, Loading } from "../components/ui.js";
import { formatSize, formatTime } from "../format.js";
import { useResource } from "../live.js";
import { href, navigate } from "../router.js";

const ROOT = "drive";
/** Folders the company keeps; they cannot be deleted. */
const KEPT = new Set(["drive/goals", "drive/inbox"]);

/** The company's shared files (decisions 23–26). Agents and the owner work from the same drive. */
export function DriveView({ path }: { path?: string }) {
  const folder = path ?? ROOT;
  const listing = useResource(
    () => api<{ path: string; entries: DriveEntry[] }>(`/drive?path=${encodeURIComponent(folder)}`),
    [folder],
    (event) => event.type.startsWith("drive."),
  );
  const upload = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      listing.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const crumbs = folder.split("/").filter(Boolean);
  const entries = [...(listing.data?.entries ?? [])].sort(
    (left, right) =>
      Number(right.kind === "folder") - Number(left.kind === "folder") ||
      left.name.localeCompare(right.name),
  );

  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Drive</h1>
          <nav class="crumbs small" aria-label="Folder">
            {crumbs.map((crumb, index) => {
              const to = crumbs.slice(0, index + 1).join("/");
              return (
                <span key={to}>
                  {index === 0 ? null : " / "}
                  {index === crumbs.length - 1 ? (
                    <strong>{crumb}</strong>
                  ) : (
                    <a href={href("drive", to)}>{crumb}</a>
                  )}
                </span>
              );
            })}
          </nav>
        </div>
        <div class="row-end">
          <button type="button" disabled={busy} onClick={() => setNaming(!naming)}>
            New folder
          </button>
          <button
            type="button"
            class="primary"
            disabled={busy}
            onClick={() => upload.current?.click()}
          >
            Upload
          </button>
          <input
            ref={upload}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [...((event.target as HTMLInputElement).files ?? [])];
              (event.target as HTMLInputElement).value = "";
              void run(async () => {
                for (const file of files) {
                  await api(`/drive/file?path=${encodeURIComponent(`${folder}/${file.name}`)}`, {
                    method: "PUT",
                    body: file,
                  });
                }
              });
            }}
          />
        </div>
      </header>

      {naming ? (
        <form
          class="secret-form drive-new-folder"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api("/drive/folder", {
                method: "POST",
                json: { path: `${folder}/${name.trim()}` },
              });
              setName("");
              setNaming(false);
            });
          }}
        >
          <input
            aria-label="Folder name"
            placeholder="Folder name"
            value={name}
            onInput={(event) => setName((event.target as HTMLInputElement).value)}
          />
          <button type="submit" class="primary" disabled={busy || name.trim() === ""}>
            Create
          </button>
        </form>
      ) : null}

      <ErrorNote message={listing.error ?? error} />
      {listing.data === undefined ? <Loading /> : null}
      {listing.data !== undefined && entries.length === 0 ? (
        <Empty title="This folder is empty.">Upload a file and every agent can read it.</Empty>
      ) : null}
      {entries.length > 0 ? (
        <ul class="card drive-list">
          {entries.map((entry) => (
            <li key={entry.path}>
              {entry.kind === "folder" ? (
                <a class="drive-name" href={href("drive", entry.path)}>
                  <span aria-hidden="true">▸ </span>
                  {entry.name}
                </a>
              ) : (
                <a class="drive-name" href={fileUrl(entry.path)} target="_blank" rel="noreferrer">
                  {entry.name}
                </a>
              )}
              <span class="small muted drive-meta">
                {entry.kind === "file" ? formatSize(entry.size) : "Folder"}
                {entry.modifiedAt === undefined ? "" : ` · ${formatTime(entry.modifiedAt)}`}
              </span>
              <span class="drive-actions">
                {entry.kind === "file" ? (
                  <a class="small" href={fileUrl(entry.path, true)}>
                    Download
                  </a>
                ) : null}
                {KEPT.has(entry.path) ? null : (
                  <button
                    type="button"
                    class="ghost danger small"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api(`/drive?path=${encodeURIComponent(entry.path)}`, {
                          method: "DELETE",
                        });
                      })
                    }
                  >
                    Delete
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {folder !== ROOT ? (
        <p class="small">
          <button
            type="button"
            class="ghost"
            onClick={() => navigate("drive", crumbs.slice(0, -1).join("/") || ROOT)}
          >
            Up one folder
          </button>
        </p>
      ) : null}
    </div>
  );
}
