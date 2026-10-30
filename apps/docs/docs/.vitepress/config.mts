import { defineConfig, type DefaultTheme } from 'vitepress'

const gettingStarted: DefaultTheme.SidebarItem[] = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Introduction', link: '/getting-started/introduction' },
      { text: 'Quick Start', link: '/getting-started/quick-start' },
      { text: 'Installation', link: '/getting-started/installation' },
      { text: 'Project Structure', link: '/getting-started/project-structure' },
      { text: 'Configuration', link: '/getting-started/configuration' },
    ],
  },
  {
    text: 'Your Framework',
    items: [
      { text: 'Next.js', link: '/getting-started/frameworks/next' },
      { text: 'Nuxt', link: '/getting-started/frameworks/nuxt' },
      { text: 'SvelteKit', link: '/getting-started/frameworks/sveltekit' },
    ],
  },
  {
    text: 'Guides',
    items: [
      { text: 'Coding with AI Agents', link: '/getting-started/ai-agents' },
      { text: 'Upgrade Guide', link: '/getting-started/upgrading' },
      { text: 'Versioning', link: '/getting-started/versioning' },
    ],
  },
]

const tutorial: DefaultTheme.SidebarItem[] = [
  {
    text: 'Tutorial: Build a Blog',
    items: [
      { text: 'Overview', link: '/tutorial/' },
      { text: '1. Create the Project', link: '/tutorial/create-project' },
      { text: '2. Database and Migrations', link: '/tutorial/database-and-migrations' },
      { text: '3. Models and Queries', link: '/tutorial/models-and-queries' },
      { text: '4. Public Pages', link: '/tutorial/public-pages' },
      { text: '5. Admin CRUD', link: '/tutorial/admin-crud' },
      { text: '6. Forms and Validation', link: '/tutorial/forms-and-validation' },
      { text: '7. Authentication', link: '/tutorial/auth' },
      { text: '8. Authorization', link: '/tutorial/authorization' },
      { text: '9. Media Uploads', link: '/tutorial/media-uploads' },
      { text: '10. Realtime and Notifications', link: '/tutorial/realtime-and-notifications' },
      { text: '11. Testing and Deployment', link: '/tutorial/testing-and-deployment' },
    ],
  },
]

const basics: DefaultTheme.SidebarItem[] = [
  {
    text: 'Basics',
    items: [
      { text: 'Routing and Requests', link: '/basics/routing' },
      { text: 'Using Holo Services', link: '/basics/services' },
      { text: 'Error Responses', link: '/basics/errors' },
      { text: 'Sessions', link: '/basics/session' },
    ],
  },
  {
    text: 'Validation',
    items: [
      { text: 'Validation', link: '/basics/validation/' },
      { text: 'Available Rules', link: '/basics/validation/rules' },
      { text: 'Error Messages', link: '/basics/validation/errors' },
    ],
  },
  {
    text: 'Forms',
    items: [
      { text: 'Forms', link: '/basics/forms/' },
      { text: 'Handling Submissions', link: '/basics/forms/server' },
      { text: 'Client-Side Forms', link: '/basics/forms/client' },
      { text: 'Framework Recipes', link: '/basics/forms/frameworks' },
    ],
  },
  {
    text: 'Security',
    items: [
      { text: 'Security Overview', link: '/basics/security/' },
      { text: 'CSRF Protection', link: '/basics/security/csrf' },
      { text: 'Rate Limiting', link: '/basics/security/rate-limiting' },
      { text: 'CORS and Proxies', link: '/basics/security/cors-and-proxies' },
    ],
  },
]

const database: DefaultTheme.SidebarItem[] = [
  {
    text: 'Database',
    items: [
      { text: 'Getting Started', link: '/database/' },
      { text: 'Migrations', link: '/database/migrations' },
      { text: 'Seeding', link: '/database/seeding' },
      { text: 'Transactions', link: '/database/transactions' },
      { text: 'Pagination', link: '/database/pagination' },
      { text: 'Multiple Connections', link: '/database/connections' },
    ],
  },
  {
    text: 'Query Builder',
    items: [
      { text: 'Basics', link: '/database/query-builder/' },
      { text: 'Selects and Filters', link: '/database/query-builder/selects-and-filters' },
      { text: 'Joins and Subqueries', link: '/database/query-builder/joins-and-subqueries' },
      { text: 'Inserts, Updates, Deletes', link: '/database/query-builder/writes' },
      { text: 'Chunking Large Results', link: '/database/query-builder/chunking' },
    ],
  },
  {
    text: 'ORM',
    items: [
      { text: 'Defining Models', link: '/orm/' },
      { text: 'Querying Models', link: '/orm/querying' },
      { text: 'Creating and Updating', link: '/orm/writes' },
      { text: 'Scopes', link: '/orm/scopes' },
      { text: 'Casts and Mutators', link: '/orm/casts' },
      { text: 'Serialization', link: '/orm/serialization' },
      { text: 'Collections', link: '/orm/collections' },
      { text: 'Observers and Model Events', link: '/orm/observers' },
      { text: 'Factories', link: '/orm/factories' },
    ],
  },
  {
    text: 'Relationships',
    items: [
      { text: 'Overview', link: '/orm/relationships/' },
      { text: 'One to One', link: '/orm/relationships/one-to-one' },
      { text: 'One to Many', link: '/orm/relationships/one-to-many' },
      { text: 'Many to Many', link: '/orm/relationships/many-to-many' },
      { text: 'Through and Polymorphic', link: '/orm/relationships/through-and-polymorphic' },
      { text: 'Eager Loading and Aggregates', link: '/orm/relationships/loading' },
    ],
  },
]

const security: DefaultTheme.SidebarItem[] = [
  {
    text: 'Authentication',
    items: [
      { text: 'Overview', link: '/auth/' },
      { text: 'Login and Registration', link: '/auth/local-auth' },
      { text: 'Sessions and Cookies', link: '/auth/session-and-cookies' },
      { text: 'Current User on the Client', link: '/auth/current-user' },
      { text: 'Guards and Providers', link: '/auth/guards-and-providers' },
      { text: 'Email Verification', link: '/auth/email-verification' },
      { text: 'Password Reset', link: '/auth/password-reset' },
      { text: 'Multi-Factor Auth', link: '/auth/multi-factor' },
      { text: 'API Tokens', link: '/auth/api-tokens' },
    ],
  },
  {
    text: 'Auth Providers',
    items: [
      { text: 'Social Login', link: '/auth/social-login' },
      { text: 'WorkOS', link: '/auth/workos' },
      { text: 'Clerk', link: '/auth/clerk' },
    ],
  },
  {
    text: 'Authorization',
    items: [
      { text: 'Overview', link: '/authorization/' },
      { text: 'Policies', link: '/authorization/policies' },
      { text: 'Abilities', link: '/authorization/abilities' },
      { text: 'Using with Auth', link: '/authorization/with-auth' },
      { text: 'Using without Auth', link: '/authorization/standalone' },
      { text: 'Jobs and Tests', link: '/authorization/jobs-and-tests' },
      { text: 'Denied Responses (403 vs 404)', link: '/authorization/errors' },
    ],
  },
]

const features: DefaultTheme.SidebarItem[] = [
  {
    text: 'Queues',
    items: [
      { text: 'Getting Started', link: '/queue/' },
      { text: 'Writing Jobs', link: '/queue/jobs' },
      { text: 'Running Workers', link: '/queue/workers' },
      { text: 'Failed Jobs', link: '/queue/failed-jobs' },
      { text: 'Drivers and Tables', link: '/queue/drivers' },
    ],
  },
  {
    text: 'Task Scheduling',
    items: [
      { text: 'Scheduling Tasks', link: '/scheduling/' },
    ],
  },
  {
    text: 'Events',
    items: [
      { text: 'Getting Started', link: '/events/' },
      { text: 'Defining Events', link: '/events/defining-events' },
      { text: 'Listeners', link: '/events/listeners' },
      { text: 'Dispatching Events', link: '/events/dispatching' },
      { text: 'Queued Listeners', link: '/events/queued-listeners' },
      { text: 'After-Commit Events', link: '/events/after-commit' },
      { text: 'Choosing a Pattern', link: '/events/choosing-patterns' },
      { text: 'API Reference', link: '/events/api-reference' },
    ],
  },
  {
    text: 'Mail',
    items: [
      { text: 'Getting Started', link: '/mail/' },
      { text: 'Writing Mail', link: '/mail/writing-mail' },
      { text: 'Markdown Mail', link: '/mail/markdown' },
      { text: 'Sending Mail', link: '/mail/sending' },
      { text: 'Attachments', link: '/mail/attachments' },
      { text: 'Queueing Mail', link: '/mail/queueing' },
      { text: 'Previewing Mail', link: '/mail/previewing' },
      { text: 'Drivers', link: '/mail/drivers' },
      { text: 'Testing Mail', link: '/mail/testing' },
    ],
  },
  {
    text: 'Notifications',
    items: [
      { text: 'Getting Started', link: '/notifications/' },
      { text: 'Writing Notifications', link: '/notifications/writing' },
      { text: 'Sending Notifications', link: '/notifications/sending' },
      { text: 'Channels', link: '/notifications/channels' },
      { text: 'Custom Channels', link: '/notifications/custom-channels' },
      { text: 'Database Notifications', link: '/notifications/database' },
      { text: 'Queueing Notifications', link: '/notifications/queueing' },
      { text: 'Delivery Results', link: '/notifications/events' },
      { text: 'Testing Notifications', link: '/notifications/testing' },
    ],
  },
  {
    text: 'Cache',
    items: [
      { text: 'Getting Started', link: '/cache/' },
      { text: 'Using the Cache', link: '/cache/usage' },
      { text: 'Locks', link: '/cache/locks' },
      { text: 'Query Caching', link: '/cache/query-caching' },
      { text: 'Drivers', link: '/cache/drivers' },
    ],
  },
  {
    text: 'Storage and Media',
    items: [
      { text: 'File Storage', link: '/storage/' },
      { text: 'Amazon S3 and Compatible', link: '/storage/s3' },
      { text: 'Media Library', link: '/media/' },
      { text: 'Image Conversions', link: '/media/conversions' },
    ],
  },
  {
    text: 'Broadcasting and Realtime',
    items: [
      { text: 'Broadcasting', link: '/broadcasting/' },
      { text: 'Events and Channels', link: '/broadcasting/events-and-channels' },
      { text: 'Listening on the Client', link: '/broadcasting/client' },
      { text: 'Drivers and Config', link: '/broadcasting/drivers' },
      { text: 'Scaling in Production', link: '/broadcasting/production' },
      { text: 'Realtime Queries', link: '/realtime/' },
    ],
  },
]

const ship: DefaultTheme.SidebarItem[] = [
  {
    text: 'Testing',
    items: [
      { text: 'Testing Your App', link: '/testing/' },
      { text: 'Database Tests', link: '/testing/database' },
      { text: 'Faking Services', link: '/testing/fakes' },
    ],
  },
  {
    text: 'Deployment',
    items: [
      { text: 'Deploying Holo Apps', link: '/deployment/' },
      { text: 'Production Checklist', link: '/deployment/checklist' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'CLI Commands', link: '/reference/cli' },
      { text: 'Custom Commands', link: '/reference/custom-commands' },
      { text: 'Configuration Files', link: '/reference/config' },
      { text: 'Environment Variables', link: '/reference/environment' },
      { text: 'Packages', link: '/reference/packages' },
    ],
  },
  {
    text: 'Advanced',
    items: [
      { text: 'How Holo Works', link: '/advanced/architecture' },
      { text: 'Writing Plugins', link: '/advanced/plugins' },
      { text: 'Contributing', link: '/advanced/contributing' },
    ],
  },
]

const expandedGroups = new Set(['Getting Started'])

const sidebar: DefaultTheme.SidebarItem[] = [
  ...gettingStarted,
  ...tutorial,
  ...basics,
  ...database,
  ...security,
  ...features,
  ...ship,
].map((group) => ({ ...group, collapsed: !expandedGroups.has(group.text ?? '') }))

export default defineConfig({
  title: 'Holo-JS',
  description: 'The backend toolkit for Next.js, Nuxt, and SvelteKit: database, ORM, auth, queues, mail, storage, and more.',
  cleanUrls: true,
  lang: 'en-US',
  lastUpdated: true,
  sitemap: {
    hostname: 'https://docs.holo-js.com',
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/mark.svg' }],
    ['meta', { name: 'theme-color', content: '#e4572e' }],
  ],
  markdown: {
    theme: {
      light: 'github-light',
      dark: 'github-dark',
    },
  },
  themeConfig: {
    logo: { src: '/mark.svg', alt: 'Holo-JS' },
    siteTitle: 'Holo-JS',
    nav: [
      { text: 'Get Started', link: '/getting-started/introduction', activeMatch: '^/getting-started/' },
      { text: 'Tutorial', link: '/tutorial/', activeMatch: '^/tutorial/' },
      {
        text: 'Docs',
        items: [
          { text: 'Basics', link: '/basics/routing', activeMatch: '^/basics/' },
          { text: 'Database & ORM', link: '/database/', activeMatch: '^/(database|orm)/' },
          { text: 'Auth & Authorization', link: '/auth/', activeMatch: '^/(auth|authorization)/' },
          { text: 'Queues, Mail & More', link: '/queue/', activeMatch: '^/(queue|events|mail|notifications|cache|storage|media|broadcasting|realtime)/' },
          { text: 'Testing & Deployment', link: '/testing/', activeMatch: '^/(testing|deployment)/' },
        ],
      },
      { text: 'CLI', link: '/reference/cli', activeMatch: '^/reference/' },
    ],
    sidebar,
    outline: { level: [2, 3], label: 'On this page' },
    search: {
      provider: 'local',
      options: {
        detailedView: true,
      },
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/cobraprojects/holo-js' },
    ],
    docFooter: { prev: 'Previous', next: 'Next' },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Holo-JS',
    },
  },
})
