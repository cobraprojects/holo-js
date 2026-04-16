import { defineConfig } from 'vitepress'

const frameworkSidebar = [
  {
    text: 'Prologue',
    items: [
      { text: 'Introduction', link: '/' },
    ],
  },
  {
    text: 'Getting Started',
    items: [
      { text: 'Installation', link: '/installation' },
      { text: 'Configuration', link: '/configuration' },
      { text: 'Directory Structure', link: '/directory-structure' },
    ],
  },
  {
    text: 'Architecture Concepts',
    items: [
      { text: 'Architecture', link: '/architecture' },
      { text: 'Routing', link: '/routing' },
      { text: 'Runtime Services', link: '/runtime-services' },
    ],
  },
  {
    text: 'The Basics',
    items: [
      { text: 'Routing', link: '/routing' },
    ],
  },
  {
    text: 'Digging Deeper',
    items: [
      { text: 'Runtime Services', link: '/runtime-services' },
      { text: 'File Storage', link: '/storage' },
      { text: 'Media', link: '/media' },
      { text: 'Application Development', link: '/development/' },
      { text: 'Contributing to Holo', link: '/development/contributing' },
    ],
  },
  {
    text: 'Validation',
    items: [
      { text: 'Overview', link: '/validation/' },
      { text: 'Rules And Errors', link: '/validation/rules-and-errors' },
    ],
  },
  {
    text: 'Forms',
    items: [
      { text: 'Overview', link: '/forms/' },
      { text: 'Server Validation', link: '/forms/server-validation' },
      { text: 'Client Usage', link: '/forms/client-usage' },
      { text: 'Framework Integration', link: '/forms/framework-integration' },
    ],
  },
  {
    text: 'Auth',
    items: [
      { text: 'Overview', link: '/auth/' },
      { text: 'Session And Cookies', link: '/auth/session-and-cookies' },
      { text: 'Local Auth', link: '/auth/local-auth' },
      { text: 'Guards And Providers', link: '/auth/guards-and-providers' },
      { text: 'Personal Access Tokens', link: '/auth/personal-access-tokens' },
      { text: 'Social Login', link: '/auth/social-login' },
      { text: 'WorkOS', link: '/auth/workos' },
      { text: 'Clerk', link: '/auth/clerk' },
      { text: 'Email Verification', link: '/auth/email-verification' },
      { text: 'Password Reset', link: '/auth/password-reset' },
      { text: 'Current Auth Client', link: '/auth/current-auth-client' },
    ],
  },
  {
    text: 'Queue',
    items: [
      { text: 'Getting Started', link: '/queue/' },
      { text: 'Jobs', link: '/queue/jobs' },
      { text: 'Workers', link: '/queue/workers' },
      { text: 'Failed Jobs', link: '/queue/failed-jobs' },
      { text: 'Database Tables', link: '/queue/database' },
      { text: 'Media Integration', link: '/queue/media' },
    ],
  },
    {
      text: 'Events',
      items: [
        { text: 'Getting Started', link: '/events/' },
        { text: 'Defining Events', link: '/events/defining-events' },
        { text: 'Defining Listeners', link: '/events/defining-listeners' },
        { text: 'Multiple Event Listeners', link: '/events/multi-event-listeners' },
        { text: 'Dispatching Events', link: '/events/dispatching-events' },
        { text: 'Setup and CLI', link: '/events/setup-and-cli' },
        { text: 'Queued Listeners', link: '/events/queued-listeners' },
        { text: 'Transactions and After Commit', link: '/events/transactions-after-commit' },
        { text: 'Choosing Patterns', link: '/events/choosing-patterns' },
        { text: 'API Reference', link: '/events/api-reference' },
      ],
    },
    {
      text: 'Mail',
      items: [
        { text: 'Overview', link: '/mail/' },
        { text: 'Creating Mails', link: '/mail/creating-mails' },
        { text: 'Sending Mails', link: '/mail/sending-mails' },
        { text: 'Previewing Mails', link: '/mail/previewing-mails' },
        { text: 'Markdown Mails', link: '/mail/markdown-mails' },
        { text: 'Notifications', link: '/mail/notifications' },
        { text: 'Attachments', link: '/mail/attachments' },
        { text: 'Queueing Mail', link: '/mail/queueing-mail' },
        { text: 'Testing', link: '/mail/testing' },
      ],
    },
    {
      text: 'Notifications',
      items: [
        { text: 'Overview', link: '/notifications/' },
        { text: 'Creating Notifications', link: '/notifications/creating-notifications' },
        { text: 'Sending Notifications', link: '/notifications/sending-notifications' },
        { text: 'On-Demand Notifications', link: '/notifications/on-demand-notifications' },
        { text: 'Notification Channels', link: '/notifications/notification-channels' },
        { text: 'Custom Channels', link: '/notifications/custom-channels' },
        { text: 'Notification Events', link: '/notifications/notification-events' },
        { text: 'Notification Storage', link: '/notifications/notification-storage' },
        { text: 'Queueing Notifications', link: '/notifications/queueing-notifications' },
        { text: 'Testing', link: '/notifications/testing' },
      ],
    },
    {
      text: 'Broadcast',
      items: [
        { text: 'Getting Started', link: '/broadcast/' },
        { text: 'Setup and CLI', link: '/broadcast/setup-and-cli' },
        { text: 'Config and Drivers', link: '/broadcast/config-and-drivers' },
        { text: 'Defining Events and Channels', link: '/broadcast/defining-events-and-channels' },
        { text: 'Flux and Framework Helpers', link: '/broadcast/flux-and-frameworks' },
        { text: 'Deployment and Scaling', link: '/broadcast/deployment-and-scaling' },
      ],
    },
  {
    text: 'Security',
    items: [
      { text: 'Security', link: '/security' },
    ],
  },
  {
    text: 'Database',
    items: [
      { text: 'Getting Started', link: '/database/' },
      { text: 'Commands', link: '/database/commands' },
      {
        text: 'Query Builder',
        link: '/database/query-builder/',
        items: [
          { text: 'Overview', link: '/database/query-builder/' },
          { text: 'Selects & Filters', link: '/database/query-builder/selects-and-filters' },
          { text: 'Joins & Subqueries', link: '/database/query-builder/joins-and-subqueries' },
          { text: 'Writes, Pagination & Chunking', link: '/database/query-builder/writes-pagination-and-chunking' },
        ],
      },
      { text: 'Pagination', link: '/database/pagination' },
      { text: 'Migrations', link: '/database/migrations' },
      { text: 'Seeding', link: '/database/seeding' },
      { text: 'Transactions', link: '/database/transactions' },
    ],
  },
  {
    text: 'ORM',
    items: [
      { text: 'Getting Started', link: '/orm/' },
      { text: 'Writes', link: '/orm/writes' },
      {
        text: 'Relationships',
        link: '/orm/relationships',
        items: [
          { text: 'Overview', link: '/orm/relationships' },
          { text: 'One to One', link: '/orm/relationships/one-to-one' },
          { text: 'One to Many', link: '/orm/relationships/one-to-many' },
          { text: 'Many to Many', link: '/orm/relationships/many-to-many' },
          { text: 'Through & Polymorphic', link: '/orm/relationships/through-and-polymorphic' },
          { text: 'Loading & Aggregates', link: '/orm/relationships/loading-and-aggregates' },
        ],
      },
      { text: 'Collections', link: '/orm/collections' },
      { text: 'Mutators / Casts', link: '/orm/mutators-casts' },
      { text: 'Serialization', link: '/orm/serialization' },
      { text: 'Factories', link: '/orm/factories' },
    ],
  },
  {
    text: 'Development',
    items: [
      { text: 'Application Development', link: '/development/' },
      { text: 'Application Workflow', link: '/development/workflow' },
      { text: 'Contributing to Holo', link: '/development/contributing' },
    ],
  },
  {
    text: 'Testing',
    items: [
      { text: 'Getting Started', link: '/testing' },
    ],
  },
  {
    text: 'Deployment',
    items: [
      { text: 'Deployment', link: '/deployment' },
    ],
  },
]

export default defineConfig({
  title: 'Holo',
  description: 'Framework documentation for Holo, a configurable backend runtime for Nuxt, Next.js, and SvelteKit.',
  cleanUrls: true,
  lang: 'en-US',
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#e4572e' }],
    ['meta', { name: 'viewport', content: 'width=device-width, initial-scale=1.0' }],
  ],
  appearance: true,
  themeConfig: {
    logo: {
      src: '/mark.svg',
      alt: 'Holo',
    },
    nav: [
      { text: 'Docs', link: '/' },
      { text: 'Database', link: '/database/' },
      { text: 'ORM', link: '/orm/' },
      { text: 'Queue', link: '/queue/' },
      { text: 'Events', link: '/events/' },
      { text: 'Broadcast', link: '/broadcast/' },
      { text: 'Forms', link: '/forms/' },
      { text: 'Storage', link: '/storage' },
      { text: 'Development', link: '/development/' },
    ],
    sidebar: frameworkSidebar,
    outline: {
      level: [2, 3],
      label: 'On this page',
    },
    search: {
      provider: 'local',
    },
    docFooter: {
      prev: 'Previous page',
      next: 'Next page',
    },
    footer: {
      message: 'Holo owns backend runtime concerns. The host framework owns SSR and routing.',
      copyright: 'Documentation site rebuilt with markdown-first editing and VitePress.',
    },
  },
})
