# ThreadPR

Post mini PRs in code review threads.

Push a branch with your proposed change, then leave this on the PR diff as a line comment. Put the command on the first line and explain the change below it.

```text
/mini-pr review/handle-failed-export

A write failure can leave a partial file. This change adds a cleanup step and a regression test.
```

ThreadPR opens a pull request from your review branch into the branch under review and replies with the link. The new PR uses the repository's existing checks and merge controls. Reviewers can use the same command on that PR to propose another layer.

## Run ThreadPR

Use Node.js 22.13 or later. The service uses the built-in SQLite module. Each database is managed by one ThreadPR process and can serve multiple GitHub installations. Put the database on persistent storage.

1. Choose the HTTPS origin that will serve ThreadPR. Generate a prefilled registration link by running the following command with your origin.

   ```sh
   npm run registration -- https://threadpr.example.com
   ```

   Add `--organization your-org` to register under an organization. Add `--public` to allow other accounts to install the App.

2. Open the link while signed in to GitHub. Enter a webhook secret and create the App. Generate a private key in the App's settings. Keep the private key and webhook secret on the server.
3. Copy `.env.example` to `.env` and configure the App ID, its slug, the private key path and the webhook secret.

   ```sh
   node --env-file=.env src/server.js
   ```

4. Route the public HTTPS origin to the service. Test the health endpoint at `/healthz`. Install ThreadPR on a test repository from the App settings, then post a command on an open PR.

The registration link enables the `pull_request_review_comment` webhook at `/webhooks/github` and sets `Pull requests` to read and write and `Contents` to read-only. [GitHub App registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)

## Repository compatibility

- Use an open PR whose head branch is in the same repository. The reviewer needs repository write access and a pushed branch with commits based on the PR's current head.
- Configure the existing test workflow to cover PRs targeting feature branches. A GitHub Actions `pull_request.branches` filter selects target branches. [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpull_requestpull_request_targetbranchesbranches-ignore)
- A new command comment records a new proposal. To update an open proposal, push to its review branch. ThreadPR associates repeat deliveries with the original comment and preserves the association across restarts.
- The GitHub App installation token is scoped to the repository that sent the webhook. ThreadPR verifies webhook signatures, checks the reviewer's repository permissions, and uses a new PR for the proposed commits. Merging happens through GitHub with the repository's normal permissions.

## Test

```sh
npm test
```

The automated tests use a local Webhook receiver and simulated GitHub API responses.
