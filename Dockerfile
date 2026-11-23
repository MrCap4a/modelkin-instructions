FROM node:24-bookworm-slim AS editor
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY frontend/*.tsx frontend/editor.css ./
COPY templates /app/templates
RUN npm run build

FROM rust:1.96.0-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock rust-toolchain.toml build.rs ./
COPY src ./src
COPY migrations ./migrations
COPY static ./static
COPY --from=editor /app/static/figma-editor.js /app/static/figma-editor.css ./static/
COPY templates ./templates
ARG REVISION=dev
ENV MODELKIN_REVISION=${REVISION}
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home modelkin
COPY --from=build /app/target/release/modelkin-instruction /usr/local/bin/modelkin-instruction
USER 10001
ENV MODELKIN_BIND=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/modelkin-instruction"]
CMD ["serve"]
