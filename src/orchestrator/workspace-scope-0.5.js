'use strict';

const base = require('./workspace-scope');
const {
  repositoryContextForDirectorySync,
  formatRepositoryContextPrompt,
} = require('./repository-context');

function workspaceScopePrompt(workspace, workspaceFolders = null) {
  const scope = base.workspaceScopePrompt(workspace, workspaceFolders);
  const roots = base.normalizeWorkspaceFolders(workspace, workspaceFolders);
  const repositoryContext = formatRepositoryContextPrompt(roots.map((root) => ({
    name: root.name,
    context: repositoryContextForDirectorySync(root.path),
  })));
  return [scope, repositoryContext].filter(Boolean).join('\n\n');
}

module.exports = {
  ...base,
  workspaceScopePrompt,
};
