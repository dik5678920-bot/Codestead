# All archives are fetched and SHA-256 checked by prepare.mjs before this offline build.
# amd64 is the reviewed target; the base pins the multi-platform manifest.
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a AS build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive PATH=/usr/local/node/bin:$PATH
COPY .downloads/ /downloads/
COPY --chmod=0444 downloads.sha256 /downloads.sha256
RUN cd /downloads && sha256sum -c /downloads.sha256 \
    && awk '$2 ~ /^debs\// { print "/downloads/" $2 }' /downloads.sha256 \
       | xargs -r apt-get --yes --no-install-recommends install \
    && mkdir -p /usr/local/node /usr/local/jdk /usr/local/python /build/piston /build/isolate \
    && tar -xJf /downloads/toolchains/node.tar.xz -C /usr/local/node --strip-components=1 \
    && tar -xzf /downloads/toolchains/java.tar.gz -C /usr/local/jdk --strip-components=1 \
    && tar -xzf /downloads/toolchains/python.tar.gz -C /usr/local/python --strip-components=1 \
    && tar -xzf /downloads/sources/piston.tar.gz -C /build/piston --strip-components=1 \
    && tar -xzf /downloads/sources/isolate.tar.gz -C /build/isolate --strip-components=1 \
    && ln -s /usr/bin/gcc-14 /usr/local/bin/gcc \
    && ln -s /usr/bin/g++-14 /usr/local/bin/g++ \
    && ln -s /usr/local/node/bin/node /usr/local/bin/node \
    && ln -s /usr/local/python/bin/python3 /usr/local/bin/python3
WORKDIR /build/isolate
RUN make -j2 CC=gcc-14 install
WORKDIR /piston_api
COPY --chmod=0444 api-package.json package.json
COPY --chmod=0444 api-package-lock.json package-lock.json
RUN npm ci --offline --ignore-scripts --omit=dev --no-audit --no-fund \
    && npm rebuild waitpid --offline --nodedir=/usr/local/node \
    && cp -a /build/piston/api/src ./src
COPY --chmod=0444 install-packages.mjs /build/install-packages.mjs
RUN node /build/install-packages.mjs
COPY --chmod=0444 build-cds.sh /build/build-cds.sh
RUN bash /build/build-cds.sh \
    && test "$(gcc-14 -dumpfullversion)" = 14.2.0 \
    && test "$(/usr/local/python/bin/python3 -I -c 'import platform; print(platform.python_version())')" = 3.14.8 \
    && test "$(node --version)" = v22.23.3 \
    && /usr/local/jdk/bin/java -XshowSettings:properties -version 2>&1 | grep -F 'java.version = 21.0.12.1'

FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
ENV PATH=/usr/local/bin:/usr/bin:/bin PISTON_LOG_LEVEL=ERROR
COPY --from=build /usr/ /usr/
COPY --from=build /lib/ /lib/
COPY --from=build /etc/ /etc/
COPY --from=build /var/lib/dpkg/ /var/lib/dpkg/
COPY --from=build /piston_api/ /piston_api/
COPY --from=build /piston/packages/ /piston/packages/
COPY --chmod=0555 entrypoint.sh /usr/local/bin/codestead-piston-entrypoint
COPY --chmod=0444 image-inputs.lock.json /usr/local/share/codestead-piston/image-inputs.lock.json
COPY --chmod=0444 build-inputs.sha256 /usr/local/share/codestead-piston/build-inputs.sha256
COPY --chmod=0444 Dockerfile entrypoint.sh build-cds.sh install-packages.mjs api-package.json api-package-lock.json image-inputs.lock.json downloads.sha256 .dockerignore /tmp/build-inputs/
RUN cd /tmp/build-inputs && sha256sum -c /usr/local/share/codestead-piston/build-inputs.sha256 \
    && rm -rf /tmp/build-inputs
RUN rm -rf /usr/local/node/lib/node_modules /usr/local/node/include /usr/local/python/lib/python3.14/ensurepip \
    /usr/local/python/lib/python3.14/site-packages/pip* /usr/share/man \
    && rm -f /usr/local/node/bin/npm /usr/local/node/bin/npx /usr/local/node/bin/corepack \
    /usr/local/python/bin/pip* \
    && mkdir -p /piston/jobs /run/isolate/locks
LABEL org.opencontainers.image.title="Codestead Piston" \
    org.opencontainers.image.source="https://github.com/thebrownhuman/Codestead" \
    io.codestead.piston.toolchains="gcc-14.2.0,temurin-21.0.12.1,python-3.14.8,node-22.23.3"
EXPOSE 2000
ENTRYPOINT ["/usr/local/bin/codestead-piston-entrypoint"]
CMD []
