import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { getConfig } from "./config.js";

async function bootstrap() {
  const { port } = getConfig();
  const app = await NestFactory.create(AppModule, { cors: true });

  const shutdown = () => {
    // Force exit after 1s — don't let open SSE connections block shutdown
    const forceTimer = setTimeout(() => process.exit(0), 1000);
    forceTimer.unref();
    app.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen(port);
  console.log(`Escapement Studio server listening on http://localhost:${port}`);
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
