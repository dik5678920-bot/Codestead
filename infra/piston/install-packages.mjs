import { mkdir, writeFile } from "node:fs/promises";

const env = "PATH=/usr/local/bin:/usr/local/jdk/bin:/usr/bin:/bin\nHOME=/tmp\nLANG=C.UTF-8\n";
async function install(name, version, provides, compile, run) {
  const root = `/piston/packages/${name}/${version}`;
  await mkdir(root, { recursive: true });
  await writeFile(`${root}/pkg-info.json`, JSON.stringify({ language: name, version, provides, build_platform: "docker-debian" }));
  await writeFile(`${root}/.env`, env);
  await writeFile(`${root}/environment`, "export PATH=/usr/local/bin:/usr/local/jdk/bin:/usr/bin:/bin\nexport LANG=C.UTF-8\n");
  await writeFile(`${root}/.ppman-installed`, "0\n");
  if (compile) await writeFile(`${root}/compile`, `#!/bin/bash\nset -euo pipefail\n${compile}\n`, { mode: 0o555 });
  await writeFile(`${root}/run`, `#!/bin/bash\nset -euo pipefail\n${run}\n`, { mode: 0o555 });
}
await install("gcc", "14.2.0", [{ language: "c", aliases: ["gcc"] }, { language: "c++", aliases: ["cpp", "g++"] }], `
case "$PISTON_LANGUAGE" in
  c) compiler=/usr/bin/gcc-14; standard=c23 ;;
  c++) compiler=/usr/bin/g++-14; standard=c++20 ;;
  *) exit 64 ;;
esac
sources=()
for file in "$@"; do
  case "$PISTON_LANGUAGE:$file" in
    c:*.c|c++:*.cpp|c++:*.cc|c++:*.cxx) sources+=("$file") ;;
  esac
done
test "\${#sources[@]}" -gt 0
exec "$compiler" -std="$standard" -O0 -pipe -Wall -Wextra -Wpedantic -fdiagnostics-color=never -I. -o program "\${sources[@]}"`, `shift; exec ./program "$@"`);
const javaLimits = "-Xms8m -Xmx64m -XX:MaxMetaspaceSize=48m -XX:ReservedCodeCacheSize=16m -XX:+UseSerialGC -XX:ActiveProcessorCount=1 -Djava.io.tmpdir=/tmp -XX:SharedArchiveFile=/usr/local/jdk/lib/codestead.jsa -Xshare:auto";
await install("java", "21.0.12", [{ language: "java", aliases: [] }], `mkdir -p classes
sources=()
for file in "$@"; do case "$file" in *.java) sources+=("$file") ;; esac; done
test "\${#sources[@]}" -gt 0
exec /usr/local/jdk/bin/java ${javaLimits} -m jdk.compiler/com.sun.tools.javac.Main -encoding UTF-8 -proc:none -d classes "\${sources[@]}"`, `main="\${1%.java}"; main="\${main//\\//.}"; shift
exec /usr/local/jdk/bin/java ${javaLimits} -cp classes "$main" "$@"`);
// Semver package identity omits Temurin's fourth component; provenance does not.
await install("python", "3.14.8", [{ language: "python", aliases: ["python3"] }], null,
  `exec /usr/local/bin/python3 -I -B "$@"`);
await install("node", "22.23.3", [{ language: "javascript", aliases: ["node", "js"] }], null,
  `exec /usr/local/bin/node --disable-proto=throw --no-addons "$@"`);
