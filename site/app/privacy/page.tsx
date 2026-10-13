import type { Metadata } from 'next'
import { Legal } from '@/components/legal'
import { links } from '@/lib/links'

export const metadata: Metadata = { title: 'Privacy policy · Slopbot' }

export default function Privacy() {
  return (
    <Legal title="Privacy policy" updated="13 October 2026">
      <p>
        This policy tells you what data Slopbot collects, why, who can see it and how long we keep it. Slopbot is an
        AI agent for Discord and a web console, made by PMServers (&quot;we&quot;, &quot;us&quot;).
      </p>

      <h2>1. Data we collect</h2>
      <ul>
        <li><b>Discord account data.</b> Your Discord user ID, name and avatar, and the IDs of servers and channels.</li>
        <li>
          <b>Messages.</b> Messages in the channels that a server admin added to Slopbot. We do not store messages
          from other channels.
        </li>
        <li><b>Prompts and replies.</b> What you send to Slopbot, in Discord or in the web console, and its replies.</li>
        <li><b>Files.</b> Files and images that you share with Slopbot.</li>
        <li><b>Memories.</b> Statements from your team that Slopbot saves, each with its source message.</li>
        <li><b>Usage.</b> Token and cost totals for each member and each server.</li>
        <li><b>Safety flags.</b> Requests that our safety check flags, with a copy of the flagged content (see section 4).</li>
        <li><b>Technical data.</b> Anonymized logs and error reports that we need to run and fix the service.</li>
      </ul>

      <h2>2. How we use data</h2>
      <ul>
        <li>To run Slopbot: answer, search history, use tools and keep memories.</li>
        <li>To apply usage limits.</li>
        <li>To find and stop misuse.</li>
        <li>To fix errors and keep the service secure.</li>
      </ul>
      <p>We do not sell your data. We do not use your data to show ads.</p>
      <p>
        We do not use your data to train AI models. 
      </p>

      <h2>3. Who can see your data</h2>
      <ul>
        <li><b>Private chats</b> in the web console: only you. They are not in channel lists, history search or memory.</li>
        <li>
          <b>Channel transcripts</b>: off by default. When a server admin turns one on, anyone who can view that
          channel in Discord can open it, with the tool steps and thinking text of each run.
        </li>
        <li><b>Shared links</b>: anyone with the link, without a sign-in. Search engines do not index them. You can revoke a link.</li>
        <li><b>Usage</b>: members see only percents of their limits.</li>
        <li><b>The Slopbot team</b>: can see safety flags and the flagged content.</li>
      </ul>

      <h2>4. Safety check</h2>
      <p>
        An automated model checks requests for harmful or misuse content, for example jailbreaks or illegal requests.
      </p>
      <ul>
        <li>
          It checks web console prompts, and Discord messages that start a run: a mention, a reply, a private chat,
          a task, or a message that Slopbot decides to answer. It does not check all channel messages.
        </li>
        <li>A server admin can also turn on checks for tool and web results. This is off by default.</li>
        <li>If a request is flagged, Slopbot refuses it. A copy of the flagged content goes to the Slopbot team for review.</li>
        <li>We keep each flag and its copy for 14 days. Then we delete them.</li>
        <li>You cannot delete a web chat that has an open flag, until the team reviews the flag or the flag expires.</li>
        <li>The safety check counts toward your usage limits.</li>
      </ul>

      <h2>5. Service providers</h2>
      <p>
        AI models run on PMS Cloud AI. We use these providers to run Slopbot:{' '}
        servers that we run, Cloudflare for network and security, and Sentry for error reports. AI requests go through PMS Cloud AI, which can send them to third-party model providers.
      </p>

      <h2>6. How long we keep data</h2>
      <ul>
        <li>Safety flags: 14 days.</li>
        <li>Messages, chats and memories: until you or an admin delete them.</li>
        <li>Usage totals: while the server uses Slopbot.</li>
        <li>Logs and error reports: only as long as we need them to run and fix the service. Logs are anonymized.</li>
        <li>When Slopbot is removed from a server, you can ask us to delete that server&apos;s data.</li>
      </ul>

      <h2>7. Your choices and rights</h2>
      <ul>
        <li>Forget your own memories with <code>memory_forget</code>.</li>
        <li>Delete your private chats and revoke your shared links in the web console.</li>
        <li>Ask us for a copy of your data, or to delete it, in the PMServers Discord server.</li>
        <li>Depending on where you live, you can have more rights by law.</li>
      </ul>

      <h2>8. Children</h2>
      <p>
        Slopbot is not for people under 13, or under the minimum age for Discord in your country.
      </p>

      <h2>9. Changes</h2>
      <p>We can change this policy. We will update the date at the top. For large changes, we will tell server admins.</p>

      <h2>10. Source code</h2>
      <p>
        The Slopbot source code is public. You can check what Slopbot collects and logs in the{' '}
        <a href="https://github.com/pretty-manageable-servers/slopbot">Slopbot repository</a>.
      </p>

      <h2>11. Contact</h2>
      <p>
        Slopbot is operated by Pretty Manageable Servers and affiliates. Correspondence is accepted in the PMServers Discord server. More details are in the{' '}
        <a href={`${links.docs}/slopbot/privacy/`}>Slopbot privacy docs</a>.
      </p>
    </Legal>
  )
}
