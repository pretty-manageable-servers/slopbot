'use client'

import { useEffect, useState } from 'react'
import { links } from '@/lib/links'

// Same limit as PRIVATE_CHAT_MAX_CHARS in src/private-chat.ts.
const MAX_CHARS = 8000

// The Ask box opens the console with the question in the URL hash: /console#ask=<text>.
// The console signs the user in if needed, starts a private chat and sends the question.
export function AskForm() {
  const [text, setText] = useState('')

  // The docs send ?q=<prompt> here. See SLOPBOT_URL in pmservers-docs.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q')
    if (q) setText(Array.from(q).slice(0, MAX_CHARS).join(''))
  }, [])

  return (
    <>
      <form
        className="ask"
        onSubmit={(event) => {
          event.preventDefault()
          const question = Array.from(text.trim()).slice(0, MAX_CHARS).join('')
          if (!question) return
          window.location.assign(`${links.console}#ask=${encodeURIComponent(question)}`)
        }}
      >
        <input
          name="q"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Plant a question…"
          aria-label="Your question"
          maxLength={MAX_CHARS}
        />
        <button className="btn solid" type="submit" disabled={!text.trim()}>Ask</button>
      </form>
      <p className="ask-note">You will sign in with Discord, then Slopbot answers in a private chat.</p>
    </>
  )
}
