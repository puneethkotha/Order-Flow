/**
 * Seeded chaos runner.
 *
 * Each scenario is fully determined by its seed: the number of orders, their
 * line items, the payment success rate, whether an operator cancel is injected,
 * and one of four fault families (partition, duplicate, reorder, crash). The
 * scenario is run to quiescence on the deterministic saga simulator (the same
 * artifact the TLA+ spec and the fast-check suite validate) and the invariant
 * catalog (I1-I8 safety, L1 liveness) is asserted after draining.
 *
 * Because every scenario is a pure function of its seed, any violation is
 * reproduced exactly by re-running the seed -- reproduction rate is 100% by
 * construction, and this runner verifies it on the violating seeds it finds.
 *
 * Usage:
 *   npm run chaos -- --seed <n> --scenarios <k> [--mode corrected|uncorrected]
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  SagaSimulator,
  mulberry32,
  FaultKind,
  SagaMode,
  InvariantReport,
} from '@orderflow/shared';

type Family = 'partition' | 'duplicate' | 'reorder' | 'crash';
const FAMILIES: Family[] = ['partition', 'duplicate', 'reorder', 'crash'];
const FAMILY_FAULTS: Record<Family, FaultKind[]> = {
  partition: ['duplicate', 'drop'], // partition during publish: re-send + transient loss
  duplicate: ['duplicate'],
  reorder: ['reorder'],
  crash: ['crash'],
};

const SKUS = ['SKU-A', 'SKU-B', 'SKU-C'];

interface ScenarioResult {
  seed: number;
  family: Family;
  ok: boolean;
  violation: string | null;
  steps: number;
}

function buildAndRun(seed: number, family: Family, mode: SagaMode): { result: ScenarioResult; sim: SagaSimulator } {
  const rng = mulberry32(seed);
  const orderCount = 1 + Math.floor(rng() * 3); // 1..3
  const paymentSuccessRate = [0, 0.5, 1][Math.floor(rng() * 3)];

  const sim = new SagaSimulator({
    mode,
    stock: { 'SKU-A': 12, 'SKU-B': 12, 'SKU-C': 12 },
    paymentSuccessRate,
    seed,
  });

  const orderIds: string[] = [];
  for (let i = 0; i < orderCount; i++) {
    const id = `s${seed}-o${i}`;
    const itemCount = 1 + Math.floor(rng() * 2);
    const items = Array.from({ length: itemCount }, () => ({
      sku: SKUS[Math.floor(rng() * SKUS.length)],
      quantity: 1 + Math.floor(rng() * 3),
    }));
    sim.createOrder(id, items);
    sim.approveOrder(id);
    orderIds.push(id);
  }
  for (const id of orderIds) {
    if (rng() < 0.3) sim.cancelOrder(id);
  }

  const { safetyViolation, liveness, steps } = sim.runChecked({ faults: FAMILY_FAULTS[family] });
  const livenessViolation = liveness.find((r: InvariantReport) => !r.holds) || null;
  const violation = safetyViolation
    ? `${safetyViolation.id} ${safetyViolation.violations[0] ?? ''}`
    : livenessViolation
      ? `${livenessViolation.id} ${livenessViolation.violations[0] ?? ''}`
      : null;

  return {
    result: { seed, family, ok: violation === null, violation, steps },
    sim,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const getArg = (name: string, def: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const baseSeed = parseInt(getArg('seed', '1'), 10);
  const scenarios = parseInt(getArg('scenarios', '1000'), 10);
  const mode = getArg('mode', 'corrected') as SagaMode;

  const start = Date.now();
  const perFamily: Record<Family, { runs: number; violations: number }> = {
    partition: { runs: 0, violations: 0 },
    duplicate: { runs: 0, violations: 0 },
    reorder: { runs: 0, violations: 0 },
    crash: { runs: 0, violations: 0 },
  };
  const violations: ScenarioResult[] = [];

  for (let i = 0; i < scenarios; i++) {
    const seed = baseSeed + i;
    const family = FAMILIES[i % FAMILIES.length];
    perFamily[family].runs += 1;
    const { result } = buildAndRun(seed, family, mode);
    if (!result.ok) {
      perFamily[family].violations += 1;
      violations.push(result);
    }
  }

  // Reproduction check: re-run every violating seed and confirm the same
  // outcome, and (for a sample when there are none) confirm determinism.
  let reproduced = 0;
  const toVerify = violations.length > 0 ? violations.map((v) => v) : [];
  for (const v of toVerify) {
    const again = buildAndRun(v.seed, v.family, mode).result;
    if (again.violation === v.violation) reproduced += 1;
  }
  // Determinism spot check on non-violating seeds.
  let determinismChecks = 0;
  let determinismOk = 0;
  for (let i = 0; i < Math.min(50, scenarios); i++) {
    const seed = baseSeed + i;
    const family = FAMILIES[i % FAMILIES.length];
    const a = buildAndRun(seed, family, mode).result;
    const b = buildAndRun(seed, family, mode).result;
    determinismChecks += 1;
    if (a.violation === b.violation && a.steps === b.steps) determinismOk += 1;
  }

  const elapsedMs = Date.now() - start;
  const summary = {
    mode,
    baseSeed,
    scenarios,
    perFamily,
    totalViolations: violations.length,
    reproductionRate:
      violations.length > 0 ? reproduced / violations.length : determinismOk / determinismChecks,
    meanScenarioMs: Number((elapsedMs / scenarios).toFixed(4)),
    elapsedMs,
    sampleViolations: violations.slice(0, 5),
  };

  const outDir = path.join(__dirname);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));

  // The corrected design must have zero violations; the runner exits non-zero
  // otherwise so the nightly job fails loudly.
  if (mode === 'corrected' && violations.length > 0) {
    process.exitCode = 1;
  }
}

main();
