import type { Metadata } from 'next'
import { Legal } from '@/components/legal'
import { links } from '@/lib/links'

export const metadata: Metadata = { title: 'Terms of service · Slopbot' }

export default function Terms() {
  return (
    <Legal title="Terms of service" updated="13 October 2026">
      <p>
        These terms apply when you use Slopbot, in Discord or in the web console. Slopbot is made by PMServers
        (&quot;we&quot;, &quot;us&quot;). If you use Slopbot, you agree to these terms and to the{' '}
        <a href={links.privacy}>privacy policy</a>.
      </p>

      <h2>1. Who can use Slopbot</h2>
      <ul>
        <li>You must be at least 13, and old enough to use Discord in your country.</li>
        <li>You must also follow the Discord Terms of Service.</li>
        <li>A server admin who adds Slopbot agrees to these terms for that server, and must tell members that Slopbot reads the channels that the admin adds.</li>
      </ul>

      <h2>2. What Slopbot does</h2>
      <p>
        Slopbot answers questions, searches the web and channel history, reads files, runs code in a sandbox, keeps
        memories, and does tasks. See the <a href={links.docs}>docs</a> for details.
      </p>

      <h2>3. AI output</h2>
      <ul>
        <li>Slopbot uses AI models. Its answers can be wrong, incomplete or out of date.</li>
        <li>Check important answers yourself. Do not use Slopbot for medical, legal, financial or safety decisions.</li>
        <li>You are responsible for what you do with its output.</li>
      </ul>

      <h2>4. Acceptable use</h2>
      <p>Do not use Slopbot to:</p>
      <ul>
        <li>Break the law, or help other people break it.</li>
        <li>Make content that sexualizes minors.</li>
        <li>Make weapons, or plan violence or harm to people, including self-harm.</li>
        <li>Harass, threaten or abuse people.</li>
        <li>Get around Slopbot&apos;s safety rules or usage limits (for example, jailbreaks).</li>
        <li>Attack, overload or misuse Slopbot, its sandbox, or other systems.</li>
        <li>Collect personal data about people without a legal basis.</li>
      </ul>

      <h2>5. Safety check</h2>
      <p>
        An automated model checks requests for misuse. Flagged requests are refused and the Slopbot team reviews
        them. Section 4 of the <a href={links.privacy}>privacy policy</a> explains what is checked and how long we
        keep it. If you break these terms, we can stop your access or remove Slopbot from a server.
      </p>

      <h2>6. Your content</h2>
      <ul>
        <li>You keep the rights to what you send to Slopbot.</li>
        <li>You give us permission to process it, only to run Slopbot as the privacy policy describes.</li>
        <li>Do not send content that you do not have the right to share.</li>
      </ul>

      <h2>7. Usage limits and price</h2>
      <ul>
        <li>Each member has a 5-hour limit and a 7-day limit in each server.</li>
        <li>We can change the limits at any time, for example to balance load.</li>
        
      </ul>

      <h2>8. Changes and ending</h2>
      <ul>
        <li>We can change, pause or stop Slopbot, or any feature, at any time.</li>
        <li>We can change these terms. We will update the date at the top. If you continue to use Slopbot, you agree to the new terms.</li>
        <li>You can stop at any time. A server admin can remove Slopbot from the server.</li>
      </ul>

      <h2>9. No warranty</h2>
      <p>
        Slopbot is provided &quot;as is&quot; and &quot;as available&quot;, without warranties of any kind, to the
        extent the law allows. This includes any plan, price or tier shown on this site, as Slopbot has no paid plans and any such plan is shown for illustration only.
      </p>

      <h2>10. Limit of liability</h2>
      <p>
        To the extent the law allows, we are not liable for indirect or consequential loss, or for loss of data or
        profit. Our total liability is limited to the amount you paid us for Slopbot in the 12 months before the claim.
      </p>

      <h2>11. Contact</h2>
      <p>
        Slopbot is operated by Pretty Manageable Servers and affiliates. Correspondence is accepted in the PMServers Discord server.
      </p>
    </Legal>
  )
}
