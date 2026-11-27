import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

import type { ChecklistState, GoalState } from "../api.js";

/** Short labels for a goal's state, shown on its badge. The full sentence comes from the server. */
const STATE_LABEL: Record<GoalState, string> = {
  drafting: "Defining done",
  queued: "Queued",
  working: "Working on it",
  waiting: "Waiting on the team",
  done: "Done",
  impossible: "Impossible",
  stopped: "Stopped",
  cancelled: "Cancelled",
};

const STATE_TONE: Record<GoalState, string> = {
  drafting: "active",
  queued: "quiet",
  working: "active",
  waiting: "active",
  done: "good",
  impossible: "warn",
  stopped: "bad",
  cancelled: "quiet",
};

export function StateBadge({ state }: { state: GoalState }) {
  return (
    <span class={`badge tone-${STATE_TONE[state]}`}>
      {STATE_TONE[state] === "active" ? <span class="pulse" aria-hidden="true" /> : null}
      {STATE_LABEL[state]}
    </span>
  );
}

const CHECK_LABEL: Record<ChecklistState, string> = {
  met: "Met",
  "not-met": "Not met yet",
  unchecked: "Not checked yet",
};

export function CheckMark({ state }: { state: ChecklistState }) {
  return (
    <span class={`check check-${state}`} role="img" aria-label={CHECK_LABEL[state]}>
      {state === "met" ? "✓" : state === "not-met" ? "✕" : ""}
    </span>
  );
}

export function Checklist({ items }: { items: { line: string; state: ChecklistState }[] }) {
  if (items.length === 0) {
    return <p class="muted">Done has not been defined yet.</p>;
  }
  return (
    <ul class="checklist">
      {items.map((item, index) => (
        <li key={index} class={`checklist-item item-${item.state}`}>
          <CheckMark state={item.state} />
          <span>{item.line}</span>
        </li>
      ))}
    </ul>
  );
}

export function Avatar({ name, working }: { name: string; working?: boolean }) {
  const initials = name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <span class={`avatar${working === true ? " working" : ""}`} aria-hidden="true">
      {initials || "?"}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <p class="empty-title">{title}</p>
      {children === undefined ? null : <div class="muted">{children}</div>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | undefined }) {
  return message === undefined ? null : (
    <p class="error" role="alert">
      {message}
    </p>
  );
}

export function Loading() {
  return <p class="muted loading">One moment.</p>;
}

/**
 * A side panel: slides in from the right on a wide screen and covers the screen on a phone.
 * Escape and the backdrop close it.
 */
export function SidePanel({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    document.body.classList.add("panel-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("panel-open");
    };
  }, [onClose]);
  return (
    <div class="panel-layer">
      <button type="button" class="panel-backdrop" aria-label="Close" onClick={onClose} />
      <div
        class={`panel${wide === true ? " panel-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <header class="panel-header">
          <h2>{title}</h2>
          <button type="button" class="ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <div class="panel-body">{children}</div>
      </div>
    </div>
  );
}
