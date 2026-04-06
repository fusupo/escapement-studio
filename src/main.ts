import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { getConfig } from "./config.js";

async function bootstrap() {
  const { port } = getConfig();
  const app = await NestFactory.create(AppModule, { cors: true });

  const shutdown = async () => {
    await app.close();
    process.exit(0);
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
