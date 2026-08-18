/**
 * Generate the committed trace bundles the GitHub Pages viewer reads.
 *
 * For each curated scenario we run the deterministic simulator in both designs
 * with the same seed and fault schedule, annotate each bundle with the step at
 * which each invariant breaks persistently, and write the bundles plus a
 * manifest under docs/traces/.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SagaSimulator, TraceBundle, FaultKind, SagaMode, checkAll } from '@orderflow/shared';

interface ScenarioSpec {
  id: string;
  title: string;
  description: string;
  stock: Record<string, number>;
  items: { sku: string; quantity: number }[];
  paymentSuccessRate: number;
  faults: FaultKind[];
  seed: number;
  duplicateApprovalToInventory?: boolean;
}

const SCENARIOS: ScenarioSpec[] = [
  {
    id: 'happy',
    title: 'Happy path',
    description:
      'Payment authorizes and inventory reserves. The corrected design captures and completes; the uncorrected design has no capture step and is stranded in FULFILLING (L1).',
    stock: { 'SKU-A': 10 },
    items: [{ sku: 'SKU-A', quantity: 2 }],
    paymentSuccessRate: 1,
    faults: [],
    seed: 7,
  },
  {
    id: 'stock-leak',
    title: 'Stock leak on payment failure',
    description:
      'Inventory reserves, then payment fails and the order is cancelled. The corrected design releases the reservation; the uncorrected design leaks it (I4).',
    stock: { 'SKU-A': 10 },
    items: [{ sku: 'SKU-A', quantity: 3 }],
    paymentSuccessRate: 0,
    faults: [],
    seed: 3,
  },
  {
    id: 'held-auth',
    title: 'Held authorization on inventory failure',
    description:
      'Payment authorizes, then inventory fails and the order is cancelled. The corrected design voids the authorization; the uncorrected design leaves it live (I5).',
    stock: { 'SKU-A': 1 },
    items: [{ sku: 'SKU-A', quantity: 5 }],
    paymentSuccessRate: 1,
    faults: [],
    seed: 5,
  },
  {
    id: 'duplicate',
    title: 'Duplicate delivery double-reserves',
    description:
      'A re-delivered ORDER_APPROVED reaches inventory. The corrected design deduplicates by eventId; the uncorrected design (offset-keyed) reserves twice (I7).',
    stock: { 'SKU-A': 10 },
    items: [{ sku: 'SKU-A', quantity: 2 }],
    paymentSuccessRate: 1,
    faults: [],
    seed: 11,
    duplicateApprovalToInventory: true,
  },
];

/**
 * For each invariant, the earliest step index from which it is violated at that
 * step and every later step (a persistent break), else null. Liveness is only
 * meaningful at quiescence, so its break is attributed to the final step.
 */
function computeBreaks(bundle: TraceBundle): Record<string, number | null> {
  const breaks: Record<string, number | null> = {};
  const ids = bundle.steps.length ? bundle.steps[0].safety.map((r) => r.id) : [];
  const n = bundle.steps.length;

  for (const id of ids) {
    let firstPersistent: number | null = null;
    for (let i = 0; i < n; i++) {
      const holdsHere = bundle.steps[i].safety.find((r) => r.id === id)?.holds ?? true;
      if (!holdsHere) {
        // Persistent if violated from i through the end.
        let persistent = true;
        for (let j = i; j < n; j++) {
          if (bundle.steps[j].safety.find((r) => r.id === id)?.holds ?? true) {
            persistent = false;
            break;
          }
        }
        if (persistent) {
          firstPersistent = i;
          break;
        }
      }
    }
    breaks[id] = firstPersistent;
  }

  for (const l of bundle.liveness) {
    breaks[l.id] = l.holds ? null : Math.max(0, n - 1);
  }
  return breaks;
}

function run(spec: ScenarioSpec, mode: SagaMode): TraceBundle {
  const sim = new SagaSimulator({
    mode,
    stock: spec.stock,
    paymentSuccessRate: spec.paymentSuccessRate,
    seed: spec.seed,
  });
  sim.createOrder('order-0', spec.items);
  sim.approveOrder('order-0');
  if (spec.duplicateApprovalToInventory) {
    const pending = sim.pending();
    const idx = pending.findIndex((m) => m.to === 'inventory' && m.type === 'ORDER_APPROVED');
    if (idx >= 0) sim.duplicate(idx);
  }
  return sim.run({ faults: spec.faults, seed: spec.seed, scenario: spec.id });
}

function main(): void {
  const outDir = path.join(__dirname, '..', 'docs', 'traces');
  fs.mkdirSync(outDir, { recursive: true });

  const manifest: any[] = [];
  for (const spec of SCENARIOS) {
    const entry: any = { id: spec.id, title: spec.title, description: spec.description, faults: spec.faults, seed: spec.seed, modes: {} };
    for (const mode of ['uncorrected', 'corrected'] as SagaMode[]) {
      const bundle = run(spec, mode);
      const breaks = computeBreaks(bundle);
      const annotated = { ...bundle, breaks };
      const file = `${spec.id}-${mode}.json`;
      fs.writeFileSync(path.join(outDir, file), JSON.stringify(annotated));
      const finalAll = checkAll(bundle.steps[bundle.steps.length - 1].world);
      entry.modes[mode] = {
        file,
        ok: bundle.ok,
        steps: bundle.steps.length,
        violated: finalAll.filter((r) => !r.holds).map((r) => r.id),
      };
    }
    manifest.push(entry);
    // eslint-disable-next-line no-console
    console.log(
      `${spec.id}: uncorrected ok=${entry.modes.uncorrected.ok} violated=[${entry.modes.uncorrected.violated}] | ` +
        `corrected ok=${entry.modes.corrected.ok} violated=[${entry.modes.corrected.violated}]`
    );
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // eslint-disable-next-line no-console
  console.log(`Wrote ${manifest.length} scenarios to docs/traces/`);
}

main();
