FROM denoland/deno:alpine-2.3.3

WORKDIR /app
COPY deno.json deno.lock worker.ts ./
RUN deno cache --lock=deno.lock worker.ts

EXPOSE 8080

CMD ["deno", "run", "--allow-all", "--cached-only", "worker.ts"]
