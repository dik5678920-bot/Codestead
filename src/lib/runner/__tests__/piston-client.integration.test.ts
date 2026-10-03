import { describe, expect, it } from "vitest";

import { isTrustedRunnerJob, runtimeByLanguage, type RunnerLanguage, type RunnerRequest } from "../client";
import { PISTON_RUNTIMES, PistonRunnerClient } from "../piston-client";
import { PRACTICE_LIMITS } from "../practice-dispatch";

// Opt-in: runs against a real Piston (e.g. the infra/piston image) only when
// PISTON_TEST_URL is set, e.g. PISTON_TEST_URL=http://127.0.0.1:2000.
const url = process.env.PISTON_TEST_URL;

const programs: Record<RunnerLanguage, Record<"hello" | "compileError" | "runtimeError" | "loop" | "memory", string>> = {
  c: {
    hello: "#include <stdio.h>\nint main(void){char b[64];if(fgets(b,64,stdin))fputs(b,stdout);puts(\"hello\");return 0;}\n",
    compileError: "int main(void){ return x; }\n",
    runtimeError: "int main(void){ return 3; }\n",
    loop: "int main(void){ for(;;); }\n",
    memory: "#include <stdlib.h>\n#include <string.h>\nint main(void){for(;;){char*p=malloc(1<<20);if(!p)return 3;memset(p,1,1<<20);}}\n",
  },
  cpp: {
    hello: "#include <iostream>\n#include <string>\nint main(){std::string l;std::getline(std::cin,l);std::cout<<l<<\"\\nhello\\n\";}\n",
    compileError: "int main(){ return x; }\n",
    runtimeError: "int main(){ return 3; }\n",
    loop: "int main(){ for(;;); }\n",
    memory: "#include <vector>\nint main(){std::vector<std::vector<char>> v;for(;;)v.emplace_back(1<<20,1);}\n",
  },
  java: {
    hello: "import java.util.*;public class Main{public static void main(String[] a){Scanner s=new Scanner(System.in);System.out.println(s.nextLine());System.out.println(\"hello\");}}\n",
    compileError: "public class Main{public static void main(String[] a){return x;}}\n",
    runtimeError: "public class Main{public static void main(String[] a){System.exit(3);}}\n",
    loop: "public class Main{public static void main(String[] a){while(true){}}}\n",
    memory: "import java.util.*;public class Main{public static void main(String[] a){List<byte[]> l=new ArrayList<>();while(true)l.add(new byte[1<<20]);}}\n",
  },
  python: {
    hello: "print(input())\nprint(\"hello\")\n",
    compileError: "def f(:\n  pass\n",
    runtimeError: "raise SystemExit(3)\n",
    loop: "while True: pass\n",
    memory: "l=[]\nwhile True: l.append(bytearray(1<<20))\n",
  },
  javascript: {
    hello: "const l=require(\"fs\").readFileSync(0,\"utf8\").split(\"\\n\")[0];console.log(l);console.log(\"hello\");\n",
    compileError: "function (\n",
    runtimeError: "process.exit(3);\n",
    loop: "for(;;){}\n",
    memory: "const l=[];for(;;)l.push(Buffer.alloc(1<<20,1));\n",
  },
};

function request(language: RunnerLanguage, source: string, mode: RunnerRequest["mode"] = "RUN", extra: Partial<RunnerRequest> = {}): RunnerRequest {
  const runtime = runtimeByLanguage[language];
  return {
    submissionId: "11111111-1111-4111-8111-111111111111",
    correlationId: "practice:integration",
    language,
    runtimeVersion: runtime.version,
    mode,
    sourceFiles: [{ path: runtime.entrypoint, content: source }],
    entrypoint: runtime.entrypoint,
    stdin: "x\n",
    limits: { ...PRACTICE_LIMITS },
    ...extra,
  };
}

describe.skipIf(!url)("Piston client against a real Piston", () => {
  const image = process.env.PISTON_TEST_IMAGE ?? "codestead-piston:integration";
  const client = new PistonRunnerClient(url ?? "http://unused", image);
  const languages = Object.keys(programs) as RunnerLanguage[];

  it("is available with every required runtime installed", async () => {
    await expect(client.checkAvailability()).resolves.toMatchObject({ available: true });
  });

  it.each(languages)("%s: matches the legacy outcome for hello, compile error, runtime error, loop and memory bomb", async (language) => {
    const expectations = [
      ["hello", "ACCEPTED"],
      ["compileError", "COMPILE_ERROR"],
      ["runtimeError", "RUNTIME_ERROR"],
      ["loop", "TIMEOUT"],
      // Match the legacy JVM's bounded heap: allocation failure is exit 1,
      // not an isolate cgroup kill (137). Keep the wrapper's legacy JVM caps.
      ["memory", language === "java" ? "RUNTIME_ERROR" : "MEMORY_LIMIT"],
    ] as const;
    for (const [program, status] of expectations) {
      const runnerRequest = request(language, programs[language][program]);
      const job = await client.submit(runnerRequest, `it-${language}-${program}`);
      expect({ program, status: job.result?.status }).toEqual({ program, status });
      expect(isTrustedRunnerJob(job, runnerRequest)).toBe(true);
      expect(job.result?.runtimeVersion).toBe(PISTON_RUNTIMES[language].label);
      expect(job.result?.imageDigest).toBe(image);
      if (program === "hello") expect(job.result?.run?.stdout).toBe("x\nhello\n");
      if (program === "runtimeError") expect(job.result?.run?.exitCode).toBe(3);
      if (program === "compileError") expect(job.result?.run).toBeUndefined();
    }
  }, 120_000);

  it.each([
    ["c", "#include <stdio.h>\nint main(void){constexpr int answer=42;printf(\"%d\\n\",answer);}\n"],
    ["cpp", "#include <concepts>\n#include <iostream>\ntemplate<std::integral T> T answer(T n){return n;}\nint main(){std::cout<<answer(42)<<'\\n';}\n"],
    ["java", "public class Main{record Answer(int n){} public static void main(String[] args){Object a=new Answer(42);if(a instanceof Answer(int n))System.out.println(n);}}\n"],
    ["python", "from string.templatelib import Template\nanswer=42\nvalue=t'{answer}'\nprint(value.interpolations[0].value)\n"],
    ["javascript", "console.log([...new Set([42]).union(new Set([42]))][0]);\n"],
  ] as const)("%s supports the intended modern language features", async (language, source) => {
    const job = await client.submit(request(language, source), `it-modern-${language}`);
    expect(job.result?.status).toBe("ACCEPTED");
    expect(job.result?.run?.stdout).toBe("42\n");
  }, 30_000);

  it.each([
    ["c", "#include <stdio.h>\n#include \"answer.h\"\nint main(void){printf(\"%d\\n\",answer());}\n", "answer.h", "static int answer(void){return 42;}\n"],
    ["cpp", "#include <iostream>\n#include \"answer.hpp\"\nint main(){std::cout<<answer()<<'\\n';}\n", "answer.hpp", "inline int answer(){return 42;}\n"],
    ["java", "public class Main{public static void main(String[] args){System.out.println(Answer.value());}}\n", "Answer.java", "class Answer{static int value(){return 42;}}\n"],
  ] as const)("%s compiles multiple files and ignores non-source resources like legacy", async (language, source, helper, content) => {
    const original = request(language, source);
    const job = await client.submit({ ...original, sourceFiles: [...original.sourceFiles,
      { path: helper, content }, { path: "notes.txt", content: "not source code" }] }, `it-files-${language}`);
    expect(job.result?.status).toBe("ACCEPTED");
    expect(job.result?.run?.stdout).toBe("42\n");
  }, 30_000);

  it("keeps learner execution unprivileged, without capabilities, networking or writable toolchains", async () => {
    const source = [
      "import os, socket",
      "assert os.getuid() >= 60000",
      "caps=[line for line in open('/proc/self/status') if line.startswith('CapEff:')][0].split()[1]",
      "assert int(caps,16)==0",
      "for name in ['/usr/local/node/bin/node','/usr/local/jdk/bin/java','/usr/local/python/bin/python3']:",
      "  try: open(name,'ab')",
      "  except OSError: pass",
      "  else: raise AssertionError('toolchain writable')",
      "s=socket.socket(); s.settimeout(0.2)",
      "try: s.connect(('1.1.1.1',443))",
      "except OSError: pass",
      "else: raise AssertionError('network reachable')",
      "print('contained')",
    ].join("\n");
    const job = await client.submit(request("python", source), "it-isolation");
    expect(job.result?.status).toBe("ACCEPTED");
    expect(job.result?.run?.stdout).toBe("contained\n");
  }, 30_000);

  it.each(languages)("%s: COMPILE and TEST modes", async (language) => {
    const compileOnly = await client.submit(request(language, programs[language].hello, "COMPILE"), "it-compile");
    expect(compileOnly.result?.status).toBe("COMPILE_ONLY");
    const tests = [
      { id: "same", visibility: "VISIBLE" as const, category: "io", stdin: "a\n", expectedStdout: "a\nhello\n", comparison: "EXACT" as const },
      { id: "other", visibility: "HIDDEN" as const, category: "io", stdin: "b\n", expectedStdout: "nope", comparison: "TRIMMED" as const },
    ];
    const testRequest = request(language, programs[language].hello, "TEST", { tests, stdin: undefined });
    const graded = await client.submit(testRequest, "it-test");
    expect(graded.result?.status).toBe("WRONG_ANSWER");
    expect(graded.result?.totals).toEqual({ passed: 1, failed: 1, total: 2 });
    expect(isTrustedRunnerJob(graded, testRequest)).toBe(true);
  }, 120_000);
});
