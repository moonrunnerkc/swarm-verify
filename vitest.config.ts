import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Long enough for a real clone and a real check run, short enough that a hang fails.
    testTimeout: 120_000,
    // Assistant worktrees, scratch space and dev workspaces are other trees, not this suite, and
    // so are the corpus's held-out tests and the repositories it clones: they run in their own.
    exclude: [
      ...configDefaults.exclude,
      ".claude/**",
      "scratchpad/**",
      ".swarm/**",
      "corpus/**",
      ".corpus-work/**",
    ],
  },
});
