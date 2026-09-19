import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/** Files run one at a time, in name order: 01-seed writes what 09-upgrade reads. */
class ByName extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    sequence: { shuffle: false, sequencer: ByName },
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
