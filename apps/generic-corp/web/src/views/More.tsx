import { CompanyPauseButton, usePause } from "../components/pause.js";
import { href } from "../router.js";

/** Every room besides the tabs. */
const ROOMS: readonly { view: string; title: string; text: string }[] = [
  { view: "deliverables", title: "Deliverables", text: "Everything handed in, by goal." },
  { view: "drive", title: "Drive", text: "The company's shared files. Upload and download." },
  {
    view: "usage",
    title: "Usage and limits",
    text: "Tokens and spend by agent and model, and optional spending limits.",
  },
  {
    view: "connections",
    title: "Connections",
    text: "GitHub, tools and the keys agents use without seeing them.",
  },
  { view: "permissions", title: "Permissions", text: "What agents may do, and what was refused." },
  {
    view: "sign-in",
    title: "Claude sign-in",
    text: "What powers the agents, and what happens when your plan's limit is reached.",
  },
  {
    view: "backups",
    title: "Backups",
    text: "Nightly copies of the company, and how to restore one.",
  },
  {
    view: "checkup",
    title: "Checkup",
    text: "Whether the company beats a single agent on the same goals. Runs only when you ask.",
  },
];

export function MoreView() {
  const pause = usePause();
  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>More</h1>
          <p class="muted">Settings, files and the rest of the building.</p>
        </div>
      </header>
      <section class="card company-pause phone-only" aria-label="Pause">
        <p class="small muted">
          Pausing lets each agent finish the step it is on. Nothing is cut off mid-action.
        </p>
        <CompanyPauseButton pause={pause} />
      </section>
      <ul class="more-list">
        {ROOMS.map((item) => (
          <li key={item.view}>
            <a href={href(item.view)}>
              <span class="more-title">{item.title}</span>
              <span class="small muted">{item.text}</span>
            </a>
          </li>
        ))}
        <li>
          <a href="/auth/login">
            <span class="more-title">Account</span>
            <span class="small muted">Sign-in and access tokens.</span>
          </a>
        </li>
      </ul>
    </div>
  );
}
