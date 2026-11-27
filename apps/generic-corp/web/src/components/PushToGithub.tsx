import { useState } from "preact/hooks";

import { ApiError, api, type GithubConnection } from "../api.js";
import { useResource } from "../live.js";
import { href } from "../router.js";
import { Toggle } from "./Toggle.js";
import { ErrorNote, SidePanel } from "./ui.js";

interface PushResult {
  pushed: { repo: string; branch: string; commit: string; files: number; url: string };
  pullRequest?: { number: number; url: string };
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "goal"
  );
}

/** Sends a goal's deliverables folder to a GitHub branch, and optionally opens a pull request. */
export function PushToGithub({ goalId, title }: { goalId: string; title: string }) {
  const github = useResource(
    () =>
      api<GithubConnection>("/connectors/github").catch((error) => {
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
          return null;
        }
        throw error;
      }),
    [],
  );
  const [open, setOpen] = useState(false);
  if (github.data === undefined || github.data === null) {
    return null;
  }
  if (!github.data.connected) {
    return (
      <p class="small muted">
        <a href={href("connections")}>Connect GitHub</a> to send these to a repository.
      </p>
    );
  }
  const repos = github.data.repos.filter((repo) => repo.canPush);
  return (
    <>
      <div class="row-end">
        <button type="button" onClick={() => setOpen(true)} disabled={repos.length === 0}>
          Push to GitHub
        </button>
      </div>
      {open ? (
        <SidePanel title="Push to GitHub" onClose={() => setOpen(false)}>
          <PushForm goalId={goalId} title={title} repos={repos.map((repo) => repo.fullName)} />
        </SidePanel>
      ) : null}
    </>
  );
}

function PushForm({ goalId, title, repos }: { goalId: string; title: string; repos: string[] }) {
  const [repo, setRepo] = useState(repos[0] ?? "");
  const [branch, setBranch] = useState(`deliverables/${slug(title)}`);
  const [path, setPath] = useState("");
  const [pull, setPull] = useState(true);
  const [prTitle, setPrTitle] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<PushResult | undefined>(undefined);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setResult(
        await api<PushResult>("/connectors/github/push", {
          method: "POST",
          json: {
            goalId,
            repo,
            branch: branch.trim(),
            message: `Deliverables: ${title}`,
            ...(path.trim() === "" ? {} : { path: path.trim() }),
            ...(pull ? { openPullRequest: { title: prTitle.trim() || title } } : {}),
          },
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (result !== undefined) {
    return (
      <div class="stack">
        <p>
          Pushed {result.pushed.files} {result.pushed.files === 1 ? "file" : "files"} to{" "}
          <a href={result.pushed.url} target="_blank" rel="noreferrer">
            {result.pushed.repo}:{result.pushed.branch}
          </a>
          .
        </p>
        {result.pullRequest === undefined ? null : (
          <p>
            Opened{" "}
            <a href={result.pullRequest.url} target="_blank" rel="noreferrer">
              pull request #{result.pullRequest.number}
            </a>
            .
          </p>
        )}
      </div>
    );
  }

  return (
    <form class="stack" onSubmit={submit}>
      <p class="small muted">
        Sends everything in this goal's deliverables folder as one commit. The default branch is
        refused, so it goes to a branch of its own.
      </p>
      <label class="label" for="push-repo">
        Repository
      </label>
      <select
        id="push-repo"
        value={repo}
        onChange={(event) => setRepo((event.target as HTMLSelectElement).value)}
      >
        {repos.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <label class="label" for="push-branch">
        Branch
      </label>
      <input
        id="push-branch"
        value={branch}
        onInput={(event) => setBranch((event.target as HTMLInputElement).value)}
      />
      <label class="label" for="push-path">
        Folder in the repository
      </label>
      <input
        id="push-path"
        placeholder="The repository's root"
        value={path}
        onInput={(event) => setPath((event.target as HTMLInputElement).value)}
      />
      <Toggle label="Open a pull request" checked={pull} onChange={setPull} />
      {pull ? (
        <input
          aria-label="Pull request title"
          value={prTitle}
          onInput={(event) => setPrTitle((event.target as HTMLInputElement).value)}
        />
      ) : null}
      <ErrorNote message={error} />
      <div class="row-end">
        <button
          type="submit"
          class="primary"
          disabled={busy || repo === "" || branch.trim() === ""}
        >
          {busy ? "Pushing…" : "Push"}
        </button>
      </div>
    </form>
  );
}
