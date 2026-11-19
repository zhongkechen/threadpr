const writeRoles = new Set(['write', 'maintain', 'admin']);

function isBranch(ref) {
  return ref !== '@' && !ref.startsWith('-') && !ref.endsWith('.') &&
    !ref.includes('..') && !ref.includes('@{') &&
    !/[\x00-\x20\x7f~^:?*\[\\]/u.test(ref) &&
    ref.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

function validId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function parseReviewCommand(payload) {
  const { action, comment, installation, repository, sender, pull_request: pr } = payload ?? {};
  if (action !== 'created' || sender?.type !== 'User' || sender.id !== comment?.user?.id ||
      typeof sender.login !== 'string' || !/^[A-Za-z0-9-]+$/.test(sender.login) ||
      typeof comment?.body !== 'string' || typeof repository?.full_name !== 'string' ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository.full_name) ||
      ![installation?.id, repository.id, pr?.number, comment.id].every(validId)) {
    return null;
  }
  const firstLine = comment.body.trimStart().split(/\r?\n/, 1)[0];
  const command = firstLine.match(/^\/mini-pr[ \t]+(\S+)[ \t]*$/u);
  const threadId = comment.in_reply_to_id ?? comment.id;
  if (!command || !isBranch(command[1]) || !validId(threadId)) return null;

  return {
    id: `${repository.id}:${comment.id}`,
    installationId: installation.id,
    repositoryId: repository.id,
    repository: repository.full_name,
    prNumber: pr.number,
    commentId: comment.id,
    threadId,
    actor: sender.login,
    branch: command[1],
  };
}

class SubmissionError extends Error {}

async function findExistingPull(client, path, target, branch, marker, botLogin) {
  const { id: repositoryId, owner } = target.repo;
  let openPull;
  const filters = { state: 'all', head: `${owner.login}:${branch}`, base: target.ref };
  for await (const pull of client.pages(path, filters)) {
    if (pull.head.repo?.id !== repositoryId || pull.head.ref !== branch ||
        pull.base.repo?.id !== repositoryId || pull.base.ref !== target.ref) continue;
    if (pull.user?.login === botLogin && pull.body?.includes(marker)) return pull;
    if (pull.state === 'open') openPull = pull;
  }
  return openPull;
}

async function createMiniPull(client, job, repoPath, parent, botLogin) {
  const base = parent.head.ref;
  const pulls = `${repoPath}/pulls`;
  const marker = `<!-- threadpr:${job.id} -->`;
  const source = await client.get(`${repoPath}/branches/${encodeURIComponent(job.branch)}`);
  const existing = await findExistingPull(client, pulls, parent.head, source.name, marker, botLogin);
  if (existing) return existing;

  const comparison = await client.get(`${repoPath}/compare/${parent.head.sha}...${source.commit.sha}`);
  if (comparison.status !== 'ahead') {
    const text = comparison.status === 'identical'
      ? 'Add a commit to your review branch and post a new command.'
      : 'Update your review branch to include the latest commit on the PR branch, then post a new command.';
    throw new SubmissionError(text);
  }

  const origin = `https://github.com/${job.repository}/pull/${job.prNumber}#discussion_r${job.commentId}`;
  try {
    return await client.post(pulls, {
      title: `Review changes for #${job.prNumber}`,
      head: source.name,
      base,
      body: `Proposed by ${job.actor} in [this review comment](${origin}).\n\n${marker}`,
    });
  } catch (error) {
    if (error.status !== 422) throw error;
    const created = await findExistingPull(client, pulls, parent.head, source.name, marker, botLogin);
    if (created) return created;
    throw new SubmissionError('GitHub rejected the mini PR. Check the branches and repository pull request settings, then post a new command.');
  }
}

export async function propose(client, job, botLogin) {
  const repoPath = `/repos/${job.repository}`;
  const permissionPath = `${repoPath}/collaborators/${encodeURIComponent(job.actor)}/permission`;
  const { permission } = await client.get(permissionPath);
  if (!writeRoles.has(permission)) return null;

  try {
    const parent = await client.get(`${repoPath}/pulls/${job.prNumber}`);
    if (parent.state !== 'open') throw new SubmissionError('Open the original PR before proposing changes.');
    if (parent.head.repo?.id !== job.repositoryId) {
      throw new SubmissionError('This installation supports PRs whose work branch is in the same repository.');
    }
    if (job.branch === parent.head.ref) {
      throw new SubmissionError('Use a separate branch for your proposed changes.');
    }

    const mini = await createMiniPull(client, job, repoPath, parent, botLogin);
    return `[Mini PR #${mini.number}](${mini.html_url}) targets the branch under review. Open it to see the diff and CI checks.`;
  } catch (error) {
    if (error instanceof SubmissionError) return error.message;
    if (error.status === 404 && error.retryable === false) {
      return 'Check that the review branch is pushed and that ThreadPR can read both branches, then post a new command.';
    }
    throw error;
  }
}

export async function reply(client, job, message, botLogin, retry) {
  const path = `/repos/${job.repository}/pulls/${job.prNumber}/comments`;
  const marker = `<!-- threadpr-reply:${job.id} -->`;
  if (retry) {
    for await (const comment of client.pages(path)) {
      if (comment.user?.login === botLogin && comment.in_reply_to_id === job.threadId &&
          comment.body?.includes(marker)) {
        return;
      }
    }
  }
  await client.post(`${path}/${job.threadId}/replies`, { body: `${message}\n\n${marker}` });
}
