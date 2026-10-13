import { Logo } from './logo'
import { links } from '@/lib/links'

// Shared frame for the terms and privacy pages.
export function Legal({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <>
      <header className="topbar">
        <div className="wrap">
          <a className="brand" href={links.home}>
            <Logo />
            Slopbot
          </a>
        </div>
      </header>

      <main className="wrap legal">
        <div className="label">Slopbot · by PMServers</div>
        <h1>{title}</h1>
        <p className="updated">Last updated: {updated}</p>
        {children}
      </main>

      <footer>
        <div className="wrap">
          <span>© 2026 PMServers</span>
          <span>
            <a href={links.terms}>Terms</a> · <a href={links.privacy}>Privacy</a> · <a href={links.docs}>Docs</a>
          </span>
        </div>
      </footer>
    </>
  )
}
