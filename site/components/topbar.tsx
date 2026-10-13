'use client'

import { useState } from 'react'
import { Logo } from './logo'
import { links } from '@/lib/links'

const tabs = [
  { href: '#top', label: 'Home' },
  { href: '#features', label: 'Features' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#start', label: 'Get started' },
]

export function Topbar() {
  const [current, setCurrent] = useState('#top')

  function switchTheme() {
    const dark = document.documentElement.classList.toggle('dark')
    try {
      localStorage.setItem('theme', dark ? 'dark' : 'light')
    } catch {}
  }

  return (
    <header className="topbar">
      <div className="wrap">
        <a className="brand" href="#top">
          <Logo />
          Slopbot
        </a>
        <nav className="tabs">
          {tabs.map((tab) => (
            <a key={tab.href} href={tab.href} className={current === tab.href ? 'on' : ''} onClick={() => setCurrent(tab.href)}>
              {tab.label}
            </a>
          ))}
          <a href={links.docs} target="_blank" rel="noopener">Docs</a>
        </nav>
        <button className="theme-switch" onClick={switchTheme}>Theme</button>
        <a className="btn solid" href={links.chat}>Open Slopbot</a>
        <a className="btn nav-add" href={links.addToDiscord}>Add to Discord</a>
      </div>
    </header>
  )
}
