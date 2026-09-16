/**
 * SPEC 12: confirms no Supabase service-role key or Twilio secret reached the client bundles.
 * Run after a production build, with the same environment the build used:
 *
 *   npm run build && npm run check:bundle            # scans .next
 *   npm run check:bundle -- path/to/.next
 *   npm run check:bundle -- --allow-missing-secrets  # accept an environment with no secrets to search for
 *
 * Exit codes: 0 clean, 1 secret found, 2 no build output, 3 nothing to search for.
 *
 * A scan that searched for nothing is not a pass. With an empty environment — a fresh clone, or any
 * shell where the Twilio variables were never exported — this used to print "(none)" and exit 0, so a
 * pipeline could record a green secret check that never looked for a Twilio secret.
 */
import path from 'node:path';
import { scanBuildOutput, type ScanResult } from './lib/bundle-secrets';
import { isMainModule } from './lib/main-module';

const ALLOW_MISSING_SECRETS = '--allow-missing-secrets';

export function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): number {
  const allowMissingSecrets = argv.includes(ALLOW_MISSING_SECRETS);
  const positional = argv.filter((arg) => arg !== ALLOW_MISSING_SECRETS);
  const nextDir = path.resolve(positional[0] ?? '.next');
  let result: ScanResult;
  try {
    result = scanBuildOutput(nextDir, env);
  } catch (error) {
    console.error(`check:bundle: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (result.leaks.length > 0) {
    for (const leak of result.leaks) console.error(`check:bundle: ${leak.reason} found in ${leak.file}`);
    console.error(`check:bundle: FAILED, ${result.leaks.length} leak(s) in ${result.scannedFiles} client files`);
    return 1;
  }
  if (result.checkedSecrets.length === 0) {
    console.warn('check:bundle: no secret values set in the environment; only service_role JWTs were searched for');
    if (!allowMissingSecrets) {
      console.error(
        `check:bundle: FAILED, nothing to search for. Run it with the same environment the build used, or pass ${ALLOW_MISSING_SECRETS} to accept that.`,
      );
      return 3;
    }
  }
  const checked = result.checkedSecrets.length > 0 ? result.checkedSecrets.join(', ') : 'none';
  console.log(`check:bundle: OK, ${result.scannedFiles} client files contain no service_role JWT or secret (${checked})`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
