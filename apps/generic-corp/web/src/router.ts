import { useEffect, useState } from "preact/hooks";

/** Hash routes: `#/goals`, `#/goals/<id>`, `#/org`, `#/org/<agentId>`, `#/more`. */
export interface Route {
  view: string;
  id?: string;
}

function parse(hash: string): Route {
  const [view = "goals", id] = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  return { view: view === "" ? "goals" : view, ...(id === undefined || id === "" ? {} : { id }) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}

export function href(view: string, id?: string): string {
  return id === undefined ? `#/${view}` : `#/${view}/${encodeURIComponent(id)}`;
}

export function navigate(view: string, id?: string): void {
  window.location.hash = href(view, id);
}
