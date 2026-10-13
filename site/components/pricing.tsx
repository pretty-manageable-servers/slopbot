'use client'

import { useState } from 'react'
import { links } from '@/lib/links'

const gardenTiers = [
  { name: 'Garden 5x', price: '$100', usage: '5x more usage than Bloom' },
  { name: 'Garden 20x', price: '$200', usage: '20x more usage than Bloom' },
]

export function Pricing() {
  const [tier, setTier] = useState<number | null>(null)
  const garden = gardenTiers[tier ?? 0]

  return (
    <section className="pricing" id="pricing">
      <div className="wrap">
        <h2>Pricing</h2>
        <p className="sub">One plan per Discord server. Cancel at any time.</p>
        <div className="plans">
          <div className="plan">
            <h3>Seed</h3>
            <p className="plan-text">Try Slopbot in your server.</p>
            <div className="price">$0 <small>/ month</small></div>
            <ul>
              <li>Our everyday model</li>
              <li>Limited usage</li>
              <li>Answers from the docs</li>
            </ul>
            <a className="btn" href={links.addToDiscord}>Add to Discord</a>
          </div>

          <div className="plan popular">
            <h3>Bloom<span className="badge">Popular</span></h3>
            <p className="plan-text">For active servers and teams.</p>
            <div className="price">$20 <small>/ month</small></div>
            <ul>
              <li>Everything in Seed</li>
              <li>More usage than Seed</li>
              <li>Advanced models</li>
              <li>Reads full threads, files and logs</li>
              <li>Memory per channel</li>
            </ul>
            <a className="btn solid" href={links.addToDiscord}>Start Bloom</a>
          </div>

          <div className="plan">
            <h3>Garden</h3>
            <p className="plan-text">For heavy, all-day use.</p>
            <div className="tier-switch">
              {gardenTiers.map((t, i) => (
                <button key={t.name} className={(tier ?? 0) === i ? 'on' : ''} onClick={() => setTier(i)}>
                  {t.name}
                </button>
              ))}
            </div>
            <div className="price">
              {tier === null && <small>From </small>}
              {garden.price} <small>/ month</small>
            </div>
            <ul>
              <li>Everything in Bloom</li>
              <li>{garden.usage}</li>
              <li>Our most capable models</li>
              <li>Custom tools and webhooks</li>
              <li>Priority access at busy times</li>
            </ul>
            <a className="btn" href={links.addToDiscord}>Start {garden.name}</a>
          </div>
        </div>
        <p className="usage-note">
          Usage limits apply to all plans and can change. On Bloom and Garden, you can turn on extra usage past your
          limit, billed at <a href={links.pmsCloudPricing}>PMS Cloud AI API rates</a>.
        </p>
      </div>
    </section>
  )
}
