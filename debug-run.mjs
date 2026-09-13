process.env.SENTRY_DEEPSEEK_MODEL = 'deepseek-v4-flash';
process.env.SENTRY_DEEPSEEK_BINARY =
  'C:\\Users\\merte\\Documents\\GitHub\\Sentry\\node_modules\\.pnpm\\@deepseek-ai+dsh@0.1.5-rc.2_kv7i25tjyojfuitq64d3qdxhlu\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const { executeCommand } = await import('./apps/cli/dist/application.js');
try {
  const result = await executeCommand({
    command: 'run.start',
    projectId: 'proj_01M2DQ98S34NEY51BHSA7DJ4K6',
    mode: 'full',
    agents: ['deepseek'],
    wait: true,
  });
  console.log('RESULT:' + JSON.stringify(result).slice(0, 500));
} catch (cause) {
  console.log('CAUSE-NAME:' + cause?.name);
  console.log('CAUSE-CTOR:' + cause?.constructor?.name);
  console.log('CAUSE-CODE:' + cause?.code);
  console.log('CAUSE-MSG:' + String(cause?.message).slice(0, 500));
  console.log('CAUSE-STACK:' + String(cause?.stack).split('\n').slice(0, 12).join(' | '));
}
