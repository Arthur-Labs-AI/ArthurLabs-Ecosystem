/**
 * Sentry restricted profile patch for DeepSeek Harness (Phase 4).
 *
 * Composes over the `sdk-minimal` base: keeps file read/search/edit, shell,
 * session, model, and sandbox capability; everything else stays unmounted.
 * Sandbox mode workspace-write is mandatory: any failure to enforce it
 * fails the run closed. The workspace root is substituted per AgentRun with
 * the Sentry-owned isolated workspace.
 *
 * Plugin/bundle composition is verified against the pinned
 * @deepseek-ai/dsh-sdk-client 0.1.5-rc.2 on the prepared host before live
 * validation; unknown composition fails loud at runtime startup.
 */
export function buildRestrictedProfilePatch(workspaceRoot: string): string {
  return (
    '# Sentry restricted profile patch (generated per AgentRun).\n' +
    "- name: '@deepseek-ai/dsh-sandbox-policy'\n" +
    '  config:\n' +
    '    mode: workspace-write\n' +
    '    workspaceRoot: ' +
    JSON.stringify(workspaceRoot) +
    '\n'
  );
}
