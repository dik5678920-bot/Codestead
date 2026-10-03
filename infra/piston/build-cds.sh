#!/bin/bash
set -euo pipefail
JAVA=/usr/local/jdk/bin/java
mkdir -p /tmp/cds-warm/classes
cat > /tmp/cds-warm/Warm.java <<'EOF'
public class Warm { public static void main(String[] args) { System.out.println("hello"); } }
EOF
# Warm real compiler system-module classes without an application classpath.
"$JAVA" -XX:ArchiveClassesAtExit=/usr/local/jdk/lib/codestead.jsa \
    -m jdk.compiler/com.sun.tools.javac.Main -d /tmp/cds-warm/classes /tmp/cds-warm/Warm.java
test -s /usr/local/jdk/lib/codestead.jsa
"$JAVA" -XX:SharedArchiveFile=/usr/local/jdk/lib/codestead.jsa -Xshare:on \
    -m jdk.compiler/com.sun.tools.javac.Main -version
test "$("$JAVA" -XX:SharedArchiveFile=/usr/local/jdk/lib/codestead.jsa -Xshare:on \
    -cp /tmp/cds-warm/classes Warm)" = hello
rm -rf /tmp/cds-warm
