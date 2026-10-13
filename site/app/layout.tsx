import type { Metadata } from 'next'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/source-serif-4'
import './globals.css'

export const metadata: Metadata = {
  title: 'Slopbot · Where ideas bloom.',
  description: 'An AI agent that lives in your Discord. By PMServers.',
  icons: { icon: '/favicon.svg' },
}

// Dark is the default. Set the theme before the first paint, so the page does not flash.
const themeScript = `try{if(localStorage.getItem('theme')!=='light')document.documentElement.classList.add('dark')}catch(e){document.documentElement.classList.add('dark')}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
