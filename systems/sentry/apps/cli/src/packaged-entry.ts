import { runProductionCli } from './production.js';

// Replaced with the committed product version by the distribution builder.
declare const SENTRY_PACKAGED_CLI_VERSION: string;
void runProductionCli(process.argv, SENTRY_PACKAGED_CLI_VERSION).then((code) => {
  process.exitCode = code;
});
