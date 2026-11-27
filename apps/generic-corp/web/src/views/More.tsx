/**
 * Screens that still live in the classic dashboard while they move over. Each link opens the
 * classic page in place; the list shrinks as screens arrive here.
 */
const CLASSIC: readonly { hash: string; title: string; text: string }[] = [
  { hash: "board", title: "Activity", text: "Every task in the company, as it moves." },
  { hash: "deliverables", title: "Deliverables", text: "Everything handed in, by goal." },
  { hash: "drive", title: "Drive", text: "The company's shared files. Upload and download." },
  { hash: "costs", title: "Usage", text: "Tokens and spend by agent, model and goal." },
  { hash: "tools", title: "Tools", text: "What agents can use." },
  { hash: "secrets", title: "Secrets", text: "Keys agents may use without seeing them." },
  { hash: "power", title: "Claude sign-in", text: "What powers the agents." },
  { hash: "permissions", title: "Permissions", text: "What agents may do, and what was refused." },
];

export function MoreView() {
  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>More</h1>
          <p class="muted">These rooms are being moved. They open in the classic dashboard.</p>
        </div>
      </header>
      <ul class="more-list">
        {CLASSIC.map((item) => (
          <li key={item.hash}>
            <a href={`/classic/#/${item.hash}`}>
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
