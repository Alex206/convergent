'use strict';

const path = require('node:path');
const base = require('./run-command-tool');
const {
  repositoryContextForDirectorySync,
  withRepositoryGhHost,
} = require('../orchestrator/repository-context');

function createRunCommandTool(defineTool, options = {}) {
  const runtime = options.runtime;
  const contextProvider = options.repositoryContextProvider ?? repositoryContextForDirectorySync;
  const wrappedRuntime = {
    async execute(owner, commandOptions = {}) {
      const runtimeCwd = commandOptions.cwd;
      const absoluteCwd = path.isAbsolute(String(runtimeCwd ?? ''))
        ? path.resolve(String(runtimeCwd))
        : path.resolve(options.workspace, String(runtimeCwd ?? '.'));
      let context = null;
      try {
        context = contextProvider(absoluteCwd);
      } catch {}
      const command = withRepositoryGhHost(commandOptions.command, context);
      if (command !== commandOptions.command) {
        base.auditUi(options.ui, {
          type: 'managed_command_github_host_context',
          agent: owner,
          host: context.host,
          repository: context.slug,
        });
      }
      return runtime.execute(owner, { ...commandOptions, command });
    },
  };

  const defineWithContext = (name, config) => defineTool(name, {
    ...config,
    description: [
      config.description,
      'For GitHub CLI commands, Convergent derives GH_HOST from the selected workspace folder origin remote unless the command explicitly sets GH_HOST. Do not guess github.com or use unsupported gh subcommand --hostname flags; explicitly set GH_HOST only when intentionally targeting another GitHub host.',
    ].filter(Boolean).join(' '),
  });

  return base.createRunCommandTool(defineWithContext, {
    ...options,
    runtime: wrappedRuntime,
  });
}

module.exports = {
  ...base,
  createRunCommandTool,
};
