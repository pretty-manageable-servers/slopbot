import { AskForm } from '@/components/ask-form'
import { Logo } from '@/components/logo'
import { Pricing } from '@/components/pricing'
import { Topbar } from '@/components/topbar'
import { links } from '@/lib/links'

const features = [
  {
    title: 'Always in the chat',
    text: 'Mention it in any channel or thread. No new app to open.',
    icon: <path d="M4 5h16v11H8l-4 4z" />,
  },
  {
    title: 'Remembers context',
    text: 'It reads the thread, so you do not repeat yourself.',
    icon: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
  },
  {
    title: 'Knows PMServers',
    text: 'Answers from the docs. Open any docs page in Slopbot.',
    icon: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M8 10l3 2-3 2M13 15h3" /></>,
  },
]

export default function Home() {
  return (
    <>
      <div id="top" />
      <Topbar />

      <main className="wrap">
        <section className="hero">
          <div>
            <div className="label">Slopbot · by PMServers</div>
            <h1>Where ideas bloom.</h1>
            <p className="lead">An AI agent that lives in your Discord. Always in the chat, ready when you ask.</p>
            <AskForm />
            <div className="row">
              <a className="btn solid" href={links.addToDiscord}>Add to Discord</a>
              <a className="btn" href={links.chat}>Open the chat</a>
              <a className="btn" href={links.docs}>Read the docs</a>
            </div>
          </div>

          <div className="chat" aria-label="Example Discord chat">
            <div className="chat-bar"><b># general</b> · your-server</div>
            <div className="msg">
              <div className="avatar">D</div>
              <div>
                <div className="who">devuser</div>
                <p>
                  @Slopbot our checkout went down for 20 min last night. Read this thread and the error logs, find
                  what broke, and write a post-mortem we can pin.
                </p>
              </div>
            </div>
            <div className="msg">
              <div className="avatar bot"><Logo /></div>
              <div>
                <div className="who">Slopbot<span className="app-tag">APP</span></div>
                <p>
                  I read 214 messages and 3 log files. The cause: the 23:40 deploy set the DB pool to{' '}
                  <code>max=5</code>. Traffic at 23:52 used all 5 connections, and requests timed out until the
                  rollback at 00:12.
                </p>
                <p>
                  Post-mortem is in <b>#incidents</b>, with a timeline, the fix (<code>max=40</code> plus an alert at
                  80%), and 2 owners to confirm.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="cards" id="features">
          {features.map((f) => (
            <div className="card" key={f.title}>
              <svg viewBox="0 0 24 24" aria-hidden="true">{f.icon}</svg>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </div>
          ))}
        </section>
      </main>

      <Pricing />

      <section className="closing" id="start">
        <div className="wrap">
          <h2>Plant a question. Watch it bloom.</h2>
          <p>Free to add. Runs on PMS Cloud AI.</p>
          <div className="row">
            <a className="btn solid" href={links.addToDiscord}>Add to Discord</a>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <span>© 2026 PMServers</span>
          <span>
            <a href={links.pmservers}>pmservers.org</a> · <a href={links.docs}>Docs</a> ·{' '}
            <a href={links.console}>Console</a> ·{' '}
            <a href={links.terms}>Terms</a> · <a href={links.privacy}>Privacy</a>
          </span>
        </div>
      </footer>
    </>
  )
}
