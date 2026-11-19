import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    organization: { type: 'string' },
    public: { type: 'boolean', default: false },
  },
});

if (positionals.length !== 1) {
  throw new Error('Usage: npm run registration -- HTTPS_ORIGIN [--organization NAME] [--public]');
}
const origin = new URL(positionals[0]);
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash ||
    origin.username || origin.password) {
  throw new Error('Use a public HTTPS origin, such as https://threadpr.example.com.');
}
if (values.organization && !/^[A-Za-z0-9-]+$/u.test(values.organization)) {
  throw new Error('Use the GitHub organization login.');
}

const settings = values.organization
  ? `/organizations/${values.organization}/settings/apps/new`
  : '/settings/apps/new';
const registration = new URL(settings, 'https://github.com');
registration.search = new URLSearchParams({
  name: 'ThreadPR',
  description: 'Post mini PRs in code review threads.',
  url: origin.href,
  public: String(values.public),
  webhook_active: 'true',
  webhook_url: new URL('/webhooks/github', origin).href,
  pull_requests: 'write',
  contents: 'read',
  'events[]': 'pull_request_review_comment',
}).toString();
console.log(registration.href);
