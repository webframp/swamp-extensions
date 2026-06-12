FROM denoland/deno:alpine-2.3.3

WORKDIR /app
COPY deno.json worker.ts ./

EXPOSE 8080

CMD ["deno", "run", "--allow-all", "worker.ts"]
