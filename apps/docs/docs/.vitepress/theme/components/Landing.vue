<script setup lang="ts">
import { ref } from 'vue'

const learnMore = ref<HTMLElement | null>(null)

const scrollToLearnMore = () => {
  learnMore.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const palette = [
  { name: 'Database', pkg: '@holo-js/db', picked: true },
  { name: 'Auth', pkg: '@holo-js/auth', picked: false },
  { name: 'Queue', pkg: '@holo-js/queue', picked: true },
  { name: 'Cache', pkg: '@holo-js/cache', picked: false },
  { name: 'Storage', pkg: '@holo-js/storage', picked: true },
  { name: 'Events', pkg: '@holo-js/events', picked: false },
  { name: 'Broadcast', pkg: '@holo-js/broadcast', picked: false },
  { name: 'Forms', pkg: '@holo-js/forms', picked: false },
]

const stack = [
  { name: 'Storage', pkg: '@holo-js/storage', size: 'sm' },
  { name: 'Queue', pkg: '@holo-js/queue', size: 'md' },
  { name: 'Database', pkg: '@holo-js/db', size: 'lg' },
]

const gaps = [
  {
    title: 'Security',
    body: 'CSRF tokens, rate limits, and CORS policies. The hooks ship with the framework; the runtime that enforces them doesn\'t.',
  },
  {
    title: 'Data',
    body: 'Frameworks don\'t pick a database, an ORM, or a migration story. Every app wires it from scratch.',
  },
  {
    title: 'Auth and sessions',
    body: 'Sessions, tokens, password reset, social login. The route is yours. The system behind it isn\'t shipped.',
  },
  {
    title: 'Background jobs',
    body: 'Queues, workers, and retry logic live outside the request lifecycle. Frameworks don\'t ship them.',
  },
  {
    title: 'Files and uploads',
    body: 'Local disks in dev, cloud buckets in prod. The bridge between the two is your problem.',
  },
  {
    title: 'Realtime',
    body: 'Channels, listeners, presence, and broadcasts. Every app reinvents the wiring on top of the framework.',
  },
]

const modules = [
  { name: 'Database', pkg: '@holo-js/db', summary: 'Typed query builder, models, migrations, and seeders.' },
  { name: 'Auth', pkg: '@holo-js/auth', summary: 'Sessions, providers, tokens, and social login.' },
  { name: 'Queue', pkg: '@holo-js/queue', summary: 'Background jobs with retries and failed-job tracking.' },
  { name: 'Cache', pkg: '@holo-js/cache', summary: 'Drivers, locks, and query-level caching.' },
  { name: 'Storage', pkg: '@holo-js/storage', summary: 'File storage across local and cloud drivers.' },
  { name: 'Events', pkg: '@holo-js/events', summary: 'Listeners, queued listeners, and after-commit hooks.' },
  { name: 'Broadcast', pkg: '@holo-js/broadcast', summary: 'Realtime channels, auth routes, and Flux helpers.' },
  { name: 'Forms', pkg: '@holo-js/forms', summary: 'Validated server actions with framework adapters.' },
]

const partners = [
  { name: 'Nuxt', detail: 'Server routes, Nitro handlers, and auto-imports keep working. Holo-JS plugs into the Nitro lifecycle.' },
  { name: 'Next.js', detail: 'App Router, route handlers, and server actions stay the source of truth. Holo-JS adds the backend layer beneath them.' },
  { name: 'SvelteKit', detail: 'Endpoints and form actions are unchanged. Holo-JS provides the runtime services they call into.' },
]
</script>

<template>
  <main class="landing">
    <section class="hero">
      <div class="hero-grid">
        <div class="hero-copy">
          <p class="eyebrow">Holo-JS</p>
          <h1 class="hero-title">Pick your backend.</h1>
          <p class="hero-tagline">
            Modular backend pieces for Nuxt, Next.js, and SvelteKit. Install what you need.
            Skip the rest.
          </p>
          <p class="hero-stamp">What you pick is what you ship.</p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="/installation">Read the docs</a>
            <button type="button" class="btn btn-ghost" @click="scrollToLearnMore">
              Learn more
              <span aria-hidden="true" class="arrow">↓</span>
            </button>
          </div>
        </div>

        <div class="builder" role="img" aria-label="A palette of Holo-JS modules with three picked blocks assembled into a backend stack">
          <div class="palette">
            <div
              v-for="(block, i) in palette"
              :key="block.name"
              class="palette-block"
              :class="{ 'is-picked': block.picked }"
              :style="{ animationDelay: `${0.05 + i * 0.05}s` }"
            >
              <span class="palette-name">{{ block.name }}</span>
              <span class="palette-pkg">{{ block.pkg }}</span>
            </div>
            <a class="palette-more" href="/installation">
              <span>+ 7 more modules</span>
              <span class="palette-more-arrow" aria-hidden="true">→</span>
            </a>
          </div>

          <p class="builder-hint" aria-hidden="true">
            <span class="builder-hint-text">Pick what you need</span>
            <span class="builder-hint-arrow">↓</span>
          </p>

          <div class="stack">
            <div
              v-for="(block, i) in stack"
              :key="block.name"
              class="stack-block"
              :class="`stack-block-${block.size}`"
              :style="{ animationDelay: `${0.7 + i * 0.18}s` }"
            >
              <span class="stack-name">{{ block.name }}</span>
              <span class="stack-pkg">{{ block.pkg }}</span>
            </div>
            <span class="stack-caption">Your stack</span>
          </div>
        </div>
      </div>
    </section>

    <section ref="learnMore" class="section gaps">
      <header class="section-header">
        <p class="eyebrow">Why Holo-JS</p>
        <h2 class="section-title">What your framework doesn't ship.</h2>
        <p class="section-lead">
          Routing and rendering come in the box. The rest of a production backend doesn't.
        </p>
      </header>
      <div class="gap-grid">
        <article v-for="gap in gaps" :key="gap.title" class="gap-card">
          <h3>{{ gap.title }}</h3>
          <p>{{ gap.body }}</p>
        </article>
      </div>
    </section>

    <section class="section modules">
      <header class="section-header">
        <p class="eyebrow">Modules</p>
        <h2 class="section-title">Pick the layers your app needs.</h2>
        <p class="section-lead">
          No bundled bloat. No defaults you didn't choose. Install one module, install all,
          or swap drivers. The runtime stays the same.
        </p>
      </header>
      <div class="module-grid">
        <article v-for="m in modules" :key="m.name" class="module-card">
          <div class="module-card-head">
            <h3>{{ m.name }}</h3>
            <code>{{ m.pkg }}</code>
          </div>
          <p>{{ m.summary }}</p>
        </article>
      </div>
    </section>

    <section class="section beside">
      <header class="section-header">
        <p class="eyebrow">Beside, not instead of</p>
        <h2 class="section-title">Holo-JS works with your framework, not around it.</h2>
        <p class="section-lead">
          Keep the routing, rendering, and conventions you already use. Holo-JS adds typed
          backend services with first-class adapters for each host.
        </p>
      </header>
      <ul class="partner-grid">
        <li v-for="p in partners" :key="p.name" class="partner-card">
          <span class="partner-name">{{ p.name }}</span>
          <span class="partner-detail">{{ p.detail }}</span>
        </li>
      </ul>
    </section>

    <section class="section final-cta">
      <div class="cta-card">
        <h2 class="cta-title">
          Start with one module. Add the next when you need it.
        </h2>
        <a class="btn btn-primary btn-large" href="/installation">Get started</a>
      </div>
    </section>
  </main>
</template>

<style scoped>
.landing {
  display: block;
  width: 100%;
  color: var(--vp-c-text-1);
}

.eyebrow {
  margin: 0 0 12px;
  font-size: 0.78rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  font-weight: 600;
}

.section {
  max-width: 1180px;
  margin: 0 auto;
  padding: 96px 32px;
}

.section-header {
  max-width: 760px;
  margin: 0 auto 56px;
  text-align: center;
}

.section-title {
  margin: 0 0 16px;
  font-size: clamp(2rem, 3.6vw, 2.8rem);
  line-height: 1.08;
  letter-spacing: -0.03em;
  font-weight: 700;
}

.section-lead {
  margin: 0;
  font-size: 1.05rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.hero {
  padding: 88px 32px 64px;
  max-width: 1280px;
  margin: 0 auto;
}

.hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  align-items: center;
  gap: 64px;
}

.hero-copy {
  max-width: 580px;
}

.hero-title {
  margin: 0 0 20px;
  font-size: clamp(2.4rem, 4.6vw, 3.8rem);
  line-height: 1;
  letter-spacing: -0.04em;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.hero-tagline {
  margin: 0 0 24px;
  font-size: 1.1rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.hero-stamp {
  display: inline-flex;
  align-items: center;
  margin: 0 0 32px;
  padding: 8px 14px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-brand-soft);
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-size: 0.86rem;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 22px;
  border-radius: 999px;
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  border: 1px solid transparent;
  cursor: pointer;
  text-decoration: none;
  transition: transform 0.15s ease, box-shadow 0.2s ease, background 0.2s ease;
  font-family: inherit;
}

.btn-primary {
  color: #fffaf3;
  background: linear-gradient(135deg, #e4572e, #ff825f);
  box-shadow: 0 16px 40px rgba(228, 87, 46, 0.28);
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 20px 48px rgba(228, 87, 46, 0.34);
}

.btn-ghost {
  color: var(--vp-c-text-1);
  background: transparent;
  border-color: var(--vp-c-border);
}

.btn-ghost:hover {
  background: var(--vp-c-bg-soft);
}

.btn-large {
  padding: 16px 30px;
  font-size: 1rem;
}

.arrow {
  font-size: 0.95rem;
  transition: transform 0.2s ease;
}

.btn-ghost:hover .arrow {
  transform: translateY(2px);
}

.builder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  width: 100%;
  max-width: 460px;
  margin: 0 auto;
}

.palette {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  width: 100%;
}

.palette-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 10px;
  border-radius: 14px;
  border: 1.5px solid var(--vp-c-border);
  background: var(--vp-c-bg-elv);
  text-align: center;
  color: var(--vp-c-text-2);
  opacity: 0;
  transform: translateY(8px);
  animation: palette-in 0.4s ease forwards;
  transition: transform 0.18s ease, border-color 0.2s ease, color 0.2s ease, background 0.2s ease;
  cursor: default;
}

.palette-block:hover {
  transform: translateY(-2px);
  border-color: var(--vp-c-brand-2);
  color: var(--vp-c-text-1);
}

.palette-block.is-picked {
  color: #fffaf3;
  border-color: transparent;
  background: linear-gradient(135deg, #f06a42, #e4572e);
  box-shadow:
    0 12px 24px rgba(228, 87, 46, 0.26),
    inset 0 1px 0 rgba(255, 255, 255, 0.28);
}

.palette-block.is-picked:hover {
  transform: translateY(-3px);
}

.palette-name {
  font-size: 0.86rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.palette-pkg {
  font-family: var(--vp-font-family-mono);
  font-size: 0.66rem;
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.palette-more {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 14px;
  border: 1.5px dashed var(--vp-c-border);
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-decoration: none;
  opacity: 0;
  transform: translateY(8px);
  animation: palette-in 0.4s ease 0.5s forwards;
  transition: border-color 0.2s ease, color 0.2s ease, transform 0.18s ease, background 0.2s ease;
}

.palette-more:hover {
  border-color: var(--vp-c-brand-2);
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  transform: translateY(-1px);
}

.palette-more-arrow {
  font-size: 0.95rem;
  transition: transform 0.18s ease;
}

.palette-more:hover .palette-more-arrow {
  transform: translateX(3px);
}

.builder-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
  padding: 0;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
  opacity: 0;
  animation: hint-in 0.5s ease 0.55s forwards;
}

.builder-hint-arrow {
  font-size: 1rem;
  color: var(--vp-c-brand-1);
  animation: hint-bounce 1.8s ease-in-out infinite;
}

.stack {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-bottom: 8px;
}

.stack-block {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 20px;
  border-radius: 14px;
  color: #fffaf3;
  background: linear-gradient(135deg, #f06a42, #e4572e);
  box-shadow:
    0 14px 28px rgba(228, 87, 46, 0.22),
    inset 0 1px 0 rgba(255, 255, 255, 0.25),
    inset 0 -2px 0 rgba(0, 0, 0, 0.16);
  opacity: 0;
  transform: translateY(20px) scale(0.96);
  animation: stack-in 0.6s cubic-bezier(0.34, 1.4, 0.55, 1) forwards;
}

.stack-block-sm {
  width: 220px;
  background: linear-gradient(135deg, #ffb38a, #f08855);
}

.stack-block-md {
  width: 280px;
  background: linear-gradient(135deg, #f9986a, #ed6f44);
}

.stack-block-lg {
  width: 340px;
  background: linear-gradient(135deg, #e4572e, #b83c1d);
}

.stack-name {
  font-size: 0.98rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.stack-pkg {
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  opacity: 0.9;
}

.stack-caption {
  margin-top: 8px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
  opacity: 0;
  animation: caption-in 0.5s ease 1.4s forwards;
}

@keyframes palette-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes hint-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes hint-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(3px); }
}

@keyframes stack-in {
  0% { opacity: 0; transform: translateY(20px) scale(0.96); }
  60% { opacity: 1; transform: translateY(-3px) scale(1.005); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes caption-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .palette-block,
  .palette-more,
  .stack-block,
  .builder-hint,
  .builder-hint-arrow,
  .stack-caption {
    animation: none;
    opacity: 1;
    transform: none;
  }
}

.gap-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.gap-card {
  position: relative;
  padding: 26px 26px 26px 30px;
  border-radius: 18px;
  border: 1px solid var(--vp-c-border);
  background: var(--vp-c-bg-elv);
  overflow: hidden;
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.gap-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 26px;
  bottom: 26px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: linear-gradient(180deg, var(--vp-c-brand-1), var(--vp-c-brand-2));
  opacity: 0.55;
  transition: opacity 0.2s ease, top 0.25s ease, bottom 0.25s ease;
}

.gap-card:hover {
  transform: translateY(-3px);
  border-color: var(--vp-c-brand-soft);
  box-shadow: 0 22px 44px rgba(36, 28, 23, 0.08);
}

.gap-card:hover::before {
  opacity: 1;
  top: 16px;
  bottom: 16px;
}

.gap-card h3 {
  margin: 0 0 8px;
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
}

.gap-card p {
  margin: 0;
  color: var(--vp-c-text-2);
  line-height: 1.55;
  font-size: 0.94rem;
}

.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}

.module-card {
  padding: 24px;
  border-radius: 20px;
  border: 1px solid var(--vp-c-border);
  background: var(--vp-c-bg-elv);
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: transform 0.2s ease, border-color 0.2s ease;
}

.module-card:hover {
  transform: translateY(-2px);
  border-color: var(--vp-c-brand-2);
}

.module-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.module-card h3 {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
}

.module-card code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--docs-inline-code-bg);
  border: 1px solid var(--docs-inline-code-border);
  color: var(--vp-c-text-2);
}

.module-card p {
  margin: 0;
  color: var(--vp-c-text-2);
  line-height: 1.55;
  font-size: 0.94rem;
}

.partner-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}

.partner-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 28px;
  border-radius: 22px;
  border: 1px solid var(--vp-c-border);
  background: var(--docs-panel-bg);
}

.partner-name {
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
}

.partner-detail {
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
  line-height: 1.6;
}

.final-cta {
  padding-bottom: 120px;
}

.cta-card {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 24px;
  padding: 56px;
  border-radius: 32px;
  border: 1px solid rgba(228, 87, 46, 0.3);
  background:
    radial-gradient(circle at top right, rgba(228, 87, 46, 0.18), transparent 55%),
    var(--docs-panel-bg);
}

.cta-title {
  margin: 0;
  max-width: 720px;
  font-size: clamp(1.6rem, 3vw, 2.4rem);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.15;
}

@media (max-width: 960px) {
  .hero {
    padding: 56px 24px 32px;
  }

  .hero-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 48px;
  }

  .hero-copy {
    max-width: none;
  }

  .section {
    padding: 72px 24px;
  }

  .gap-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .builder {
    max-width: 420px;
  }

  .stack-block-sm {
    width: 60%;
    min-width: 200px;
  }

  .stack-block-md {
    width: 80%;
    min-width: 240px;
  }

  .stack-block-lg {
    width: 100%;
    min-width: 280px;
  }

  .cta-card {
    padding: 36px 24px;
    border-radius: 24px;
  }

  .final-cta {
    padding-bottom: 80px;
  }
}

@media (max-width: 520px) {
  .hero-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .btn {
    justify-content: center;
  }

  .gap-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .palette {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stack-block {
    padding: 12px 16px;
  }

  .stack-name {
    font-size: 0.9rem;
  }

  .stack-pkg {
    font-size: 0.68rem;
  }
}
</style>
