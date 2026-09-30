import { spawn, type SpawnOptions } from "node:child_process";

const liveChildren = new Set<() => void>();
process.once("exit", () => { for (const kill of liveChildren) kill(); });

// Preserve parallel test files without launching every cold fixture import at
// once inside each file. Scenario execution remains unchanged.
export async function prepareSequentially<T, R>(
  cases: readonly T[], prepare: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const item of cases) results.push(await prepare(item));
  return results;
}

export async function prepareChild(args: string[], options: SpawnOptions) {
  const child = spawn(process.execPath, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  liveChildren.add(kill);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => {
      liveChildren.delete(kill);
      resolve({ code, signal });
    });
  });
  await new Promise<void>((resolve, reject) => {
    const ready = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)
        || message.type !== "FIXTURE_READY") return;
      child.off("error", fail);
      child.off("close", closed);
      child.off("message", ready);
      resolve();
    };
    const fail = (error: Error) => { kill(); reject(error); };
    const closed = () => fail(new Error(`Fixture exited during preparation: ${stderr}`));
    child.once("error", fail);
    child.once("close", closed);
    child.on("message", ready);
  });
  let started = false;
  return {
    child,
    exit,
    kill,
    stdout: () => stdout,
    stderr: () => stderr,
    start() {
      if (started) throw new Error("Prepared fixture already started.");
      started = true;
      child.send({ type: "FIXTURE_RUN" });
    },
    async run(timeoutMs: number) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        this.start();
        const result = await Promise.race([
          exit,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              kill();
              reject(new Error("Prepared fixture exceeded its scenario deadline."));
            }, timeoutMs);
          }),
        ]);
        return { ...result, status: result.code, error: undefined, stdout, stderr };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
