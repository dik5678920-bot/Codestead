#!/bin/bash
set -euo pipefail
JAVA=/usr/local/jdk/bin/java
mkdir -p /tmp/cds-warm/classes
cat > /tmp/cds-warm/Warm.java <<'EOF'
public class Warm { public static void main(String[] args) { System.out.println("hello"); } }
EOF
# Record the real compiler system-module classes without an application classpath.
"$JAVA" -XX:DumpLoadedClassList=/tmp/cds-warm/raw.classlist \
    -m jdk.compiler/com.sun.tools.javac.Main -d /tmp/cds-warm/classes /tmp/cds-warm/Warm.java
# The raw list's order and ids vary between runs, and a dynamic archive
# (archive-at-exit) is never byte-identical. A static dump of a sorted,
# id-free class list is, which keeps the image digest reproducible.
sed -n 's/^\([A-Za-z0-9_$/]*\)\( id: [0-9]*\)\{0,1\}$/\1/p' /tmp/cds-warm/raw.classlist \
    | LC_ALL=C sort -u > /tmp/cds-warm/codestead.classlist
test "$(wc -l < /tmp/cds-warm/codestead.classlist)" -gt 1000
"$JAVA" -Xshare:dump -XX:SharedClassListFile=/tmp/cds-warm/codestead.classlist \
    -XX:SharedArchiveFile=/usr/local/jdk/lib/codestead.jsa > /tmp/cds-warm/dump.log 2>&1 \
    || { cat /tmp/cds-warm/dump.log; exit 1; }
test -s /usr/local/jdk/lib/codestead.jsa
"$JAVA" -XX:SharedArchiveFile=/usr/local/jdk/lib/codestead.jsa -Xshare:on \
    -m jdk.compiler/com.sun.tools.javac.Main -version
test "$("$JAVA" -XX:SharedArchiveFile=/usr/local/jdk/lib/codestead.jsa -Xshare:on \
    -cp /tmp/cds-warm/classes Warm)" = hello
rm -rf /tmp/cds-warm
