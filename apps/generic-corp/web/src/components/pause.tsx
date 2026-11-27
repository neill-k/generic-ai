import { useState } from "preact/hooks";

import { api, type PauseView } from "../api.js";
import { type Resource, useResource } from "../live.js";

/** The company's pause state, kept live. */
export function usePause(): Resource<PauseView> {
  return useResource(
    () => api<PauseView>("/pause"),
    [],
    (event) => event.type === "company.paused",
  );
}

/**
 * Pauses or resumes the whole company (decision 33). Pausing lets each running turn finish its
 * current step first; nothing is cut off mid-action.
 */
export function CompanyPauseButton({ pause }: { pause: Resource<PauseView> }) {
  const [busy, setBusy] = useState(false);
  const paused = pause.data?.company === true;
  return (
    <button
      type="button"
      class={paused ? "primary pause-button" : "pause-button"}
      disabled={busy || pause.data === undefined}
      onClick={async () => {
        setBusy(true);
        try {
          await api("/pause", { method: "PUT", json: { paused: !paused } });
          pause.reload();
        } finally {
          setBusy(false);
        }
      }}
    >
      {paused ? "Resume work" : "Pause the company"}
    </button>
  );
}

export function PauseBanner({ pause }: { pause: Resource<PauseView> }) {
  if (pause.data?.company !== true) {
    return null;
  }
  return (
    <div class="pause-banner" role="status">
      <strong>The company is paused.</strong> Agents finished the step they were on and are waiting.
      Nothing proceeds until you resume work.
      <CompanyPauseButton pause={pause} />
    </div>
  );
}

export function AgentPauseButton({ agentId, name }: { agentId: string; name: string }) {
  const pause = usePause();
  const [busy, setBusy] = useState(false);
  const paused = pause.data?.agents.includes(agentId) === true;
  return (
    <div class="agent-pause">
      <button
        type="button"
        class={paused ? "primary" : undefined}
        disabled={busy || pause.data === undefined}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/agents/${encodeURIComponent(agentId)}/pause`, {
              method: "PUT",
              json: { paused: !paused },
            });
            pause.reload();
          } finally {
            setBusy(false);
          }
        }}
      >
        {paused ? `Resume ${name}` : `Pause ${name}`}
      </button>
      <span class="small muted">
        {paused
          ? "Paused. Its work waits until you resume it."
          : pause.data?.company === true
            ? "The whole company is paused."
            : "Pausing lets it finish its current step first."}
      </span>
    </div>
  );
}
