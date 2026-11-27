import { render } from "preact";

import { api, type CompanyInfo } from "./api.js";
import { CompanyPauseButton, PauseBanner, usePause } from "./components/pause.js";
import { useLiveStatus, useResource } from "./live.js";
import { href, useRoute } from "./router.js";
import "./styles.css";
import { ActivityView } from "./views/Activity.js";
import { CheckupView } from "./views/Checkup.js";
import { ConnectionsView } from "./views/Connections.js";
import { DeliverablesView } from "./views/Deliverables.js";
import { DriveView } from "./views/Drive.js";
import { GoalView } from "./views/Goal.js";
import { GoalsView } from "./views/Goals.js";
import { MemoryView } from "./views/Memory.js";
import { MoreView } from "./views/More.js";
import { OrgView } from "./views/Org.js";
import { PermissionsView } from "./views/Permissions.js";
import { SignInView } from "./views/SignIn.js";
import { UsageView } from "./views/Usage.js";

const NAV: readonly { view: string; label: string; icon: string }[] = [
  { view: "goals", label: "Goals", icon: "◎" },
  { view: "activity", label: "Activity", icon: "↯" },
  { view: "org", label: "Org chart", icon: "⌗" },
  { view: "memory", label: "Memory", icon: "✎" },
  { view: "more", label: "More", icon: "≡" },
];

/** Settings rooms live under More in the navigation. */
const navView = (view: string) =>
  ["connections", "permissions", "checkup", "drive", "deliverables", "usage", "sign-in"].includes(
    view,
  )
    ? "more"
    : view;

function App() {
  const route = useRoute();
  const live = useLiveStatus();
  const company = useResource(() => api<CompanyInfo>("/company"), []);
  const name = company.data?.name ?? "Generic Corp";
  const pause = usePause();

  let page: preact.JSX.Element;
  if (route.view === "goals" && route.id !== undefined) {
    page = <GoalView goalId={route.id} />;
  } else if (route.view === "org") {
    page = <OrgView agentId={route.id} company={company.data} />;
  } else if (route.view === "memory") {
    page = <MemoryView scopeId={route.id} />;
  } else if (route.view === "activity") {
    page = <ActivityView />;
  } else if (route.view === "connections") {
    page = <ConnectionsView />;
  } else if (route.view === "drive") {
    page = <DriveView path={route.id} />;
  } else if (route.view === "deliverables") {
    page = <DeliverablesView />;
  } else if (route.view === "usage") {
    page = <UsageView />;
  } else if (route.view === "sign-in") {
    page = <SignInView />;
  } else if (route.view === "checkup") {
    page = <CheckupView />;
  } else if (route.view === "permissions") {
    page = <PermissionsView />;
  } else if (route.view === "more") {
    page = <MoreView />;
  } else {
    page = <GoalsView />;
  }

  return (
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href={href("goals")}>
          <span class="brand-mark" aria-hidden="true">
            {name.slice(0, 1)}
          </span>
          <span>
            <span class="brand-name">{name}</span>
            <span class="brand-tagline">We care deeply about our employees.</span>
          </span>
        </a>
        <nav aria-label="Main" class="nav">
          {NAV.map((item) => (
            <a
              key={item.view}
              href={href(item.view)}
              class={navView(route.view) === item.view ? "active" : undefined}
              aria-current={navView(route.view) === item.view ? "page" : undefined}
            >
              <span class="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </a>
          ))}
        </nav>
        <div class="sidebar-foot">
          <CompanyPauseButton pause={pause} />
          <span class={`live${live ? " on" : ""}`}>{live ? "Live" : "Reconnecting…"}</span>
        </div>
      </aside>
      <main class="main" id="main">
        <PauseBanner pause={pause} />
        {page}
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root !== null) {
  render(<App />, root);
}
