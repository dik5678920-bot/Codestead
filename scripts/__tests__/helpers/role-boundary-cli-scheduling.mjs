import os from "node:os";

// This real-entrypoint smoke test owns one execution slot. Do not infer its
// resource budget from host CPU count while other Vitest workers run beside it.
// All real lanes and their deadlines remain in use, in their declared order.
os.availableParallelism = () => 1;
