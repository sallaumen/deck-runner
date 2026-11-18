FROM docker.io/library/node:22-bookworm-slim AS node
FROM docker.io/library/elixir:1.19.5-otp-27
ENV DEBIAN_FRONTEND=noninteractive MIX_ENV=test ERL_FLAGS="+S 3:3" HEX_CACERTS_PATH=/etc/ssl/certs/ca-certificates.crt
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d && apt-get update && apt-get install -y --no-install-recommends postgresql postgresql-client python3 ca-certificates build-essential git curl && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN mix local.hex --force && mix local.rebar --force
RUN apt-get update && apt-get install -y --no-install-recommends jq sqlite3 zstd && rm -rf /var/lib/apt/lists/* && useradd -m -u 1000 runner && cp -a /root/.mix /opt/mix && mkdir -p /opt/hex && chown -R runner:runner /opt/mix /opt/hex
ENV MIX_HOME=/opt/mix HEX_HOME=/opt/hex
RUN apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*
COPY run-project.sh /usr/local/bin/run-project
RUN chmod +x /usr/local/bin/run-project
ENTRYPOINT ["/usr/local/bin/run-project"]
