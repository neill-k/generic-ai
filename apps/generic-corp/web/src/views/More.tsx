import { CompanyPauseButton, usePause } from "../components/pause.js";
import { href } from "../router.js";

/** Rooms already moved into the new app. */
const ROOMS: readonly { view: string; title: string; text: string }[] = [
  {
    view: "connections",
    title: "Connections",
    text: "GitHub, tools and the keys agents use without seeing them.",
  },
  { view: "permissions", title: "Permissions", text: "What agents may do, and what was refused." },
  {
    view: "checkup",
    title: "Checkup",
    text: "Whether the company beats a single agent on the same goals. Runs only when you ask.",
  },
];

/**
 * Screens that still live in the classic dashboard while they move over. Each link opens the
 * classic page in place; the list shrinks as screens arrive here.
 */
const CLASSIC: readonly { hash: string; title: string; text: string }[] = [
  { hash: "deliverables", title: "Deliverables", text: "Everything handed in, by goal." },
  { hash: "drive", title: "Drive", text: "The company's shared files. Upload and download." },
  { hash: "costs", title: "Usage", text: "Tokens and spend by agent, model and goal." },
  { hash: "power", title: "Claude sign-in", text: "What powers the agents." },
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
        {CLASSIC.map((item) => (
          <li key={item.hash}>
            <a href={`/classic/#/${item.hash}`}>
              <span class="more-title">{item.title}</span>
              <span class="small muted">{item.text} Opens in the classic dashboard.</span>
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
